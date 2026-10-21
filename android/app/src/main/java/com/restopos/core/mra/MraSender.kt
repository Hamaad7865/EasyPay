package com.restopos.core.mra

import android.content.Context
import com.restopos.core.common.Uuid7
import com.restopos.core.data.PosSettings
import com.restopos.core.database.DeviceEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.time.Instant
import java.time.ZoneOffset
import javax.inject.Inject
import javax.inject.Singleton

// The till and the MRA (docs/superpowers/plans/2026-10-21-mra-phase-2-till.md,
// Task 12): it signs in with the login typed on it, sends each invoice as it
// is paid, sends what waited, and tells EasyPay's server what became of each
// (mra.record) and how it stands (mra.status). One send at a time: a payment's
// sendNow and the worker's drain never send the same invoice at once.
@Singleton
class MraSender @Inject constructor(
    private val db: TillDatabase,
    private val login: MraLogin,
    private val http: MraHttp,
    private val session: SessionStore,
    @ApplicationContext private val context: Context,
) {
    private val lock = Mutex()

    // the reason of the last request the MRA refused whole (ERR0020, an EBS
    // not active...), until one is answered: for Settings, MRA and the banner
    private val _problem = MutableStateFlow<String?>(null)
    val problem: StateFlow<String?> = _problem

    // what the MRA said of the last invoices it answered for: TEST (its sandbox,
    // a Test Drive) or LIVE. Kept across restarts; nothing secret.
    private val kept = context.getSharedPreferences("mra_state", Context.MODE_PRIVATE)
    private val _environment = MutableStateFlow(kept.getString(ENVIRONMENT, null))
    val environment: StateFlow<String?> = _environment

    sealed interface Connect
    data class Connected(val until: Long?) : Connect
    data class NotConnected(val why: String) : Connect

    private suspend fun settings() = PosSettings.parse(db.ops().settings())
    private suspend fun me(): DeviceEntity? = session.deviceId()?.let { db.catalog().device(it) }

    // Connect to the MRA: signs in now, with the login just typed
    suspend fun connect(): Connect = lock.withLock { signIn(refresh = false, asked = true) }

    // What a till checks on its own (MraWorker): a token kept fresh, so that a
    // sale rarely signs in first, and what waits sent.
    suspend fun tick() {
        val left = lock.withLock {
            val s = settings()
            if (s.mraOn && login.login() != null) token()
            drainLocked(BATCH_MS, once = false)
        }
        if (left) later()
        status()
    }

    // An invoice just paid: sent now, behind any older one still waiting, with
    // about 10 seconds for an answer (the receipt waits for its QR code).
    suspend fun sendNow(budgetMs: Long = PAY_MS) {
        val left = lock.withLock { drainLocked(budgetMs, once = true) }
        if (left) later()
        status()
    }

    // Send again, once, an invoice sent twice with no answer (a manager's call)
    suspend fun sendAgain(id: String) {
        if (db.mra().sendAgain(id) > 0) MraWork.soon(context, 0)
    }

    // What still waits goes when the line is back; one that went with no
    // answer, not before a couple of minutes (the guide: no hurried retries).
    private suspend fun later() {
        val first = db.mra().waiting(1).firstOrNull() ?: return
        MraWork.soon(context, if (first.status == "unsure") UNSURE_WAIT_MS else 0)
    }

    private suspend fun signIn(refresh: Boolean, asked: Boolean): Connect {
        val now = System.currentTimeMillis()
        val s = settings()
        val connect = s.mraConnect ?: return NotConnected("EasyPay has not given this till the MRA's address and key yet. Let it sync, then try again.")
        val ebs = me()?.mra_ebs_id ?: return NotConnected("This till has no EBS MRA ID yet. Ask EasyPay.")
        val l = login.login() ?: return NotConnected("Type the MRA login first.")
        // a refused login is not tried again on its own for an hour: the MRA may lock it
        if (!asked) login.refusedAt()?.let { if (now - it < HOUR_MS) return NotConnected(login.state.value.refused ?: "The MRA refused the login.") }
        val key = runCatching { MraCrypto.publicKeyOf(connect.certificate.toByteArray(Charsets.UTF_8)) }
            .getOrElse { return NotConnected("The MRA's key EasyPay sent cannot be read. Ask EasyPay.") }
        val aes = MraCrypto.newAesKey()
        val req = MraApi.tokenRequest(connect.url, MraApi.Who(l.username, l.password, ebs, l.areaCode), aes, refresh, key)
        val out = http.post(req, SIGN_IN_MS)
        val result = when (out) {
            is MraHttp.Out.Answered -> {
                val body = runCatching { Json.parseToJsonElement(out.body) as? JsonObject }.getOrNull()
                if (body == null) NotConnected("The MRA did not answer as it should (HTTP ${out.http}). Try again in a moment.")
                else when (val t = runCatching { MraApi.readToken(body, aes) }.getOrElse { MraApi.Refused(listOf("The MRA's key could not be read")) }) {
                    is MraApi.Signed -> { login.saveToken(t.token, t.invoiceKey, t.expiresAt, now); Connected(t.expiresAt) }
                    is MraApi.Refused -> { login.refuse(t.errors.joinToString("; "), now); NotConnected(t.errors.joinToString("; ")) }
                }
            }
            // the network, not the login: nothing is marked refused
            else -> NotConnected("The MRA did not answer. Check the internet connection and try again.")
        }
        return result
    }

    // A token good for 10 minutes more, signed in again each day (it lasts 24 hours).
    private suspend fun token(): MraLogin.Token? {
        val now = System.currentTimeMillis()
        val t = login.token()
        val day = { ms: Long -> Instant.ofEpochMilli(ms).atOffset(ZoneOffset.ofHours(4)).toLocalDate() }
        if (t != null && (t.until ?: 0) - now > 10 * 60_000 && day(t.signedAt) == day(now)) return t
        return if (signIn(refresh = t != null, asked = false) is Connected) login.token() else null
    }

    // Sends what waits, oldest first, 500 a request. Returns whether anything is left waiting.
    private suspend fun drainLocked(timeoutMs: Long, once: Boolean): Boolean {
        val s = settings()
        val connect = s.mraConnect ?: return hasWaiting()
        val device = me() ?: return hasWaiting()
        val ebs = device.mra_ebs_id ?: return hasWaiting()
        val l = login.login() ?: return hasWaiting()
        var signedAgain = false
        while (true) {
            val waiting = db.mra().waiting(MraQueue.MAX + 100)
            if (waiting.isEmpty()) return false
            val refs = waiting.mapNotNull { it.ref_identifier }
            val statuses = if (refs.isEmpty()) emptyMap() else db.mra().statusOf(refs).associate { it.identifier to it.status }
            val batch = MraQueue.next(waiting, statuses, ebs)
            if (batch.isEmpty()) return true
            val t = token() ?: return true
            val now = System.currentTimeMillis()
            val req = MraApi.transmitRequest(connect.url, MraApi.Who(l.username, l.password, ebs, l.areaCode), t.token, t.key, batch.map { it.invoice }, now)
            val ids = batch.map { it.id }
            // written down before it goes: from now on it may have reached the MRA
            db.mra().sending(ids)
            when (val read = MraQueue.read(http.post(req, timeoutMs))) {
                is MraQueue.Answered -> {
                    _problem.value = null
                    read.environment?.let { if (it != _environment.value) { _environment.value = it; kept.edit().putString(ENVIRONMENT, it).apply() } }
                    batch.forEach { e ->
                        val f = read.each[e.identifier] ?: return@forEach // not answered for: stays as it went, unsure
                        db.mra().answer(e.id, MraQueue.status(f), f.irn, f.qr, list(f.errors), list(f.warnings), System.currentTimeMillis(), read.responseId)
                    }
                    report(ids)
                }
                is MraQueue.RefusedWhole -> {
                    db.mra().notSent(ids)
                    if (read.token && !signedAgain) { login.dropToken(); signedAgain = true; continue }
                    _problem.value = read.errors.joinToString("; ").take(300)
                    return true
                }
                MraQueue.NotReached -> { db.mra().notSent(ids); return true }
                MraQueue.NoAnswer -> { report(ids); return true }
            }
            if (once) return hasWaiting()
        }
    }

    private suspend fun hasWaiting() = db.mra().waiting(1).isNotEmpty()

    private fun list(l: List<String>) = kotlinx.serialization.json.JsonArray(l.map { kotlinx.serialization.json.JsonPrimitive(it) }).toString()

    // what became of each, to the server (mra.record, the answer columns)
    private suspend fun report(ids: List<String>) {
        db.mra().byIds(ids).forEach { e ->
            db.outbox().enqueue(OutboxEntity(Uuid7.next(), "mra.record", MraIssue.record(e).toString()))
        }
        pushNow(context)
    }

    // How this till stands with the MRA, to the server (mra.status): when it
    // changes, and its waiting count at most once a minute. Never the login,
    // the token or a key.
    private var lastStatus: String? = null
    private var lastStatusAt = 0L
    private suspend fun status() {
        val device = session.deviceId() ?: return
        val s = settings()
        // from the day the business is moved to the MRA (setting up too): /admin
        // and the back office say whether each till is connected before training
        if (s.mra == "off" && !hasWaiting()) return
        val c = db.mra().counts().first()
        val st = login.state.value
        val now = System.currentTimeMillis()
        val core = buildJsonObject {
            put("connected", st.until != null && st.refused == null && (st.until ?: 0) > now)
            st.until?.let { put("until", Instant.ofEpochMilli(it).toString()) }
            put("refused", st.refused)
            put("problem", _problem.value)
            put("check", c.check); put("refused_invoices", c.refused)
            // TEST or LIVE, as the MRA last said: /admin flags a live client's till still counted as TEST
            put("environment", _environment.value)
        }
        val full = buildJsonObject {
            core.forEach { (k, v) -> put(k, v) }
            put("waiting", c.waiting)
            c.oldestWaiting?.let { put("oldest_waiting", Instant.ofEpochMilli(it).toString()) }
            c.lastFiscalised?.let { put("last_fiscalised", Instant.ofEpochMilli(it).toString()) }
            put("counter", me()?.mra_counter ?: 0)
        }
        val coreText = core.toString()
        if (coreText == lastStatus && now - lastStatusAt < 60_000) return
        if (full.toString() == lastFull) return
        lastStatus = coreText; lastStatusAt = now; lastFull = full.toString()
        db.outbox().enqueue(OutboxEntity(Uuid7.next(), "mra.status", buildJsonObject {
            put("device_id", device)
            putJsonObject("status") { full.forEach { (k, v) -> put(k, v) } }
        }.toString()))
        pushNow(context)
    }
    private var lastFull: String? = null

    private companion object {
        const val PAY_MS = 10_000L
        const val BATCH_MS = 30_000L
        const val SIGN_IN_MS = 15_000L
        const val HOUR_MS = 3_600_000L
        const val UNSURE_WAIT_MS = 120_000L
        const val ENVIRONMENT = "environment"
    }
}
