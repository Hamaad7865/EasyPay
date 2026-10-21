package com.restopos.core.data

import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.time.ZoneId
import javax.inject.Inject
import javax.inject.Singleton

// A day nobody closed is closed by the till at the time its business set
// (AutoCloseRules has when, and as of what moment). Looked at from the
// moment the app is up, every minute, and at the first touch after a quiet
// stretch: a till left alone overnight, asleep or with the app closed, finds
// its quiet stretch when it is next touched or started. Nothing here hangs
// off a sync: an offline tablet does it too.
@Singleton
class AutoClose @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val cash: CashOps,
    private val sell: SellCheck,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()
    private var job: Job? = null
    private val startedAt = System.currentTimeMillis()
    // the last touch, key or scan in this run of the app
    @Volatile private var quietSince = startedAt
    private val first = CompletableDeferred<Unit>()

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            // the stretch before this run of the app: from the last touch it
            // wrote down (MainActivity, once a minute) to now. One written
            // since the app started is this run's, and already in quietSince.
            val before = session.lastUse()?.takeIf { it < startedAt } ?: startedAt
            runCatching { look(before, startedAt) }
            first.complete(Unit)
            while (isActive) {
                delay(60_000)
                runCatching { look(quietSince, System.currentTimeMillis()) }
            }
        }
    }

    // A touch, a key, a scan, the app back in front: the quiet that ends here
    // is looked at first, then a new one starts.
    fun touched(now: Long) {
        val from = quietSince
        quietSince = now
        if (now - from >= AutoCloseRules.QUIET_MS) scope.launch { runCatching { look(from, now) } }
    }

    // A sign-in waits, a few seconds at most, for the look made as the app
    // started: the day left open last night is closed before anyone sells.
    suspend fun settled() { withTimeoutOrNull(5_000) { first.await() } }

    // The day closed if this quiet stretch closes it. Internal for the debug
    // build's DEMO_NIGHT, which looks at a stretch it names.
    internal suspend fun look(quietFrom: Long, quietTo: Long) = lock.withLock {
        val at = PosSettings.parse(db.ops().settings()).autoClose ?: return@withLock
        val device = session.deviceId() ?: return@withLock
        val open = db.staff().openShift(device)
        val dayFrom = open?.opened_at ?: cash.unclosedSince() ?: return@withLock
        val zone = ZoneId.systemDefault()
        val moment = AutoCloseRules.decide(dayFrom, at, zone, cash.lastWritten(dayFrom), quietFrom, quietTo)
            ?.coerceAtMost(System.currentTimeMillis()) ?: return@withLock
        sell.closing(true)
        try {
            val z = if (open != null) cash.closeDayAuto(moment) else cash.closeUnclosedAuto(moment)
            session.setAutoClosed(AutoCloseRules.notice(z.number, moment, z.carried, zone, counted = open != null))
        } finally {
            sell.closing(false)
        }
    }
}
