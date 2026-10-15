package com.restopos.core.data

import com.restopos.core.common.Chime
import com.restopos.core.common.Uuid7
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

// A banner across the top of the till: which order is due soon.
data class DueBanner(val ticketId: String, val text: String)

// The till rings before an order for later is due (DueReminder has the rule),
// whichever screen is open and while it is locked, as Kitchen.ready does: it
// is watched from here for as long as the till runs, every 30 seconds, over
// the orders on this till's Takeaway board. What it rang for is kept
// (SessionStore.dueRung), so a restart does not ring again. A banner stays
// until OK is pressed or its order no longer waits on the kitchen.
@Singleton
class DueReminders @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private val clock = SimpleDateFormat("HH:mm", Locale.UK)
    private val _banners = MutableStateFlow<List<DueBanner>>(emptyList())
    val banners: StateFlow<List<DueBanner>> = _banners

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            while (isActive) {
                runCatching { look() }
                delay(30_000)
            }
        }
    }

    fun dismiss(ticketId: String) { _banners.value = _banners.value.filter { it.ticketId != ticketId } }

    private suspend fun look() {
        val s = PosSettings.parse(db.ops().settings())
        val store = session.storeId()
        if (s.retail || s.dueReminder == 0 || store == null) { _banners.value = emptyList(); return }
        val kinds = db.catalog().diningOptions().associate { it.id to it.kind }
        val orders = db.service().board(store).first().map { t ->
            DueReminder.Order(
                t.id, t.order_no ?: t.name ?: "A takeaway", t.name, t.dining_option_id?.let { kinds[it] } == "delivery",
                t.due_at, t.stage, t.no_show_at != null, Uuid7.millis(t.id),
            )
        }
        val now = System.currentTimeMillis()
        val rung = DueReminder.read(session.dueRung())
        val ring = DueReminder.toRing(orders, now, s.prepMinutes, s.dueReminder, rung.keys)
        if (ring.isNotEmpty()) {
            session.setDueRung(DueReminder.keep(rung + ring.associate { DueReminder.key(it) to it.dueAt!! }, now))
            Chime.due()
            val fresh = ring.map { DueBanner(it.id, DueReminder.says(it, now) { at -> clock.format(Date(at)) }) }
            _banners.value = _banners.value.filter { b -> ring.none { it.id == b.ticketId } } + fresh
        }
        // a banner goes once its order is ready, handed over or gone
        val still = orders.filter { DueReminder.waiting(it) }.map { it.id }.toSet()
        _banners.value = _banners.value.filter { it.ticketId in still }
    }
}
