package com.restopos.core.kitchen

import androidx.room.withTransaction
import com.restopos.core.data.Kitchen
import com.restopos.core.data.PosSettings
import com.restopos.core.data.Routing
import com.restopos.core.data.ServiceRepository
import com.restopos.core.database.KdsScreenEntity
import com.restopos.core.database.KdsTicketEntity
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.Printing
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

// "There is something new for the kitchen screens": said by whoever wrote it
// down (a send, a void, a tick on the till's own Kitchen screen), heard by
// ScreenLink, which then asks every screen at once in place of waiting its turn.
@Singleton
class ScreenKick @Inject constructor() {
    private val _asked = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val asked: SharedFlow<Unit> = _asked
    fun now() { _asked.tryEmit(Unit) }
}

// How a kitchen screen stands, for Settings, Printers: whether it answered
// last time, how many orders it has not confirmed, and what is wrong in words.
data class ScreenStatus(val answering: Boolean, val waiting: Int, val trouble: String?, val heardAt: Long?)

// The till's side of the kitchen screens, at work. A screen is a tablet in
// the kitchen at an address on the restaurant's own Wi-Fi (the back office,
// Printers). The till writes down what each screen is owed when an order is
// sent, and keeps exchanging with each until it has it; what the cooks did
// comes back on the same exchange and is recorded the way a tap on the till's
// own Kitchen screen is (Kitchen), so the server and the takeaway board hear
// of it as they always did. Nothing here goes through the internet.
//
// The rules are in Parts and Wire, and are tested there; this class reads and
// writes the till's database and opens the connections.
@Singleton
class ScreenLink @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val kitchen: Kitchen,
    private val service: ServiceRepository,
    private val printing: Printing,
    private val kick: ScreenKick,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    // one exchange at a time with each screen, by its address
    private val turns = ConcurrentHashMap<String, Mutex>()
    private fun turn(s: PrinterEntity): Mutex = turns.getOrPut(Routing.line(s)) { Mutex() }

    // The screens this till sends to: this store's, switched on, and none at
    // all unless the restaurant's plan carries them (server 0085).
    private suspend fun screens(): List<PrinterEntity> {
        val settings = PosSettings.parse(db.ops().settings())
        if (!settings.premium || settings.retail) return emptyList()
        return printing.screens()
    }

    // An order was sent: each screen's part of it is written down. Called
    // inside the transaction that marks the lines as sent, so a part exists
    // exactly when its lines are sent; the screens are then asked (kick).
    suspend fun write(ticket: KdsTicketEntity?, lineIds: List<String>) {
        if (ticket == null || lineIds.isEmpty()) return
        val screens = screens()
        if (screens.isEmpty()) return
        val wanted = lineIds.toSet()
        val rows = db.tickets().allLines(ticket.ticket_id).filter { it.id in wanted }
        val lines = service.describe(rows).map { l ->
            WireLine(l.line.id, l.units, l.line.name_snapshot, l.detail) to l.line.item_id?.let { db.ops().categoryOfItem(it) }?.let { Routing.ids(it.printer_ids) }
        }
        val parts = Parts.of(ticket, lines, screens)
        if (parts.isNotEmpty()) db.service().upsertParts(parts)
    }

    fun kick() = kick.now()

    // Starts asking the screens, once: from then on for as long as the till
    // runs. With no screen, or on a plan without them, it only looks again
    // now and then.
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch { loop() }
    }

    private suspend fun loop() {
        val failures = HashMap<String, Int>()
        val due = HashMap<String, Long>()
        var asked = true
        while (scope.isActive) {
            var wait = LOOK_AGAIN
            runCatching {
                for (s in screens()) {
                    val now = System.currentTimeMillis()
                    if (asked || now >= (due[s.id] ?: 0)) {
                        val answered = exchange(s)?.ok == true
                        failures[s.id] = if (answered) 0 else (failures[s.id] ?: 0) + 1
                        due[s.id] = System.currentTimeMillis() + Parts.pause(db.service().partsOpen(s.id).size, failures[s.id] ?: 0)
                    }
                    wait = minOf(wait, (due[s.id] ?: 0) - System.currentTimeMillis())
                }
            }
            // until the soonest screen is due, or something new is written down
            asked = withTimeoutOrNull(wait.coerceIn(250, LOOK_AGAIN)) { kick.asked.first() } != null
        }
    }

    // One exchange with one screen. The reply, or null when nothing answered.
    private suspend fun exchange(s: PrinterEntity, again: Boolean = true): WireReply? = turn(s).withLock {
        val dao = db.service()
        val state = dao.screenState(s.id) ?: KdsScreenEntity(s.id)
        val put = Parts.toPut(dao.partsOpen(s.id))
        val out = dao.outOf(s.id)
        val at = Wire.address(s.address)
        val reply = if (at == null) null else {
            val device = session.deviceId()
            val till = device?.let { db.catalog().device(it) }
            val request = WireRequest(
                till = device ?: "", tillName = till?.name ?: "Till", tillCode = till?.code ?: "", screen = s.name,
                put = put.mapNotNull { Wire.decodeTicket(it.payload) }, marks = out.mapNotNull { Wire.decodeMark(it.mark) }, after = state.read_to,
                now = System.currentTimeMillis(),
            )
            val payload = Wire.encode(request, s.pair_code.orEmpty())
            withContext(Dispatchers.IO) { runCatching { ScreenClient.exchange(at.first, at.second, payload) }.getOrNull() }?.let { Wire.decodeReply(it) }
        }
        if (reply == null || !reply.ok) {
            // said when it changes, not every few seconds: a new order waiting changes it
            val words = Parts.trouble(s.name, s.address, reply, put.size)
            if (words != state.trouble) {
                dao.saveScreenState(state.copy(trouble = words))
                words?.let { printing.report(it) }
            }
            return@withLock reply
        }
        val now = System.currentTimeMillis()
        if (state.epoch.isNotEmpty() && reply.epoch != state.epoch) {
            // The tablet was set up afresh: it holds nothing it was sent, and
            // its list of what the cooks did starts again. Everything open is
            // owed to it again, from the beginning.
            db.withTransaction {
                dao.undeliver(s.id)
                dao.saveScreenState(KdsScreenEntity(s.id, reply.epoch, 0, now, null))
            }
            return@withLock if (again) exchangeUnlocked(s) else reply
        }
        db.withTransaction {
            if (put.isNotEmpty()) dao.setDelivered(s.id, put.map { it.kds_id })
            if (out.isNotEmpty()) dao.removeOut(out.map { it.id })
            // what it confirmed once and no longer holds is owed again
            val lost = Parts.lost(dao.partsOpen(s.id), reply.have)
            if (lost.isNotEmpty()) dao.setUndelivered(s.id, lost)
        }
        // What the cooks did, recorded as a tap on the till's own Kitchen
        // screen is. Each says what a thing is now, so one taken twice (the
        // till stopped before it wrote down how far it had read) changes nothing.
        for (m in reply.marks) runCatching { apply(s.id, m, now) }
        dao.saveScreenState(KdsScreenEntity(s.id, reply.epoch, reply.seq, now, null))
        if (state.trouble != null) printing.report("${Parts.called(s.name)} is answering again.")
        reply
    }

    // the second exchange after a tablet was found set up afresh; the turn is already held
    private suspend fun exchangeUnlocked(s: PrinterEntity): WireReply? {
        val dao = db.service()
        val state = dao.screenState(s.id) ?: return null
        val put = Parts.toPut(dao.partsOpen(s.id))
        val at = Wire.address(s.address) ?: return null
        val device = session.deviceId()
        val till = device?.let { db.catalog().device(it) }
        val request = WireRequest(
            till = device ?: "", tillName = till?.name ?: "Till", tillCode = till?.code ?: "", screen = s.name,
            put = put.mapNotNull { Wire.decodeTicket(it.payload) }, after = 0, now = System.currentTimeMillis(),
        )
        val payload = Wire.encode(request, s.pair_code.orEmpty())
        val reply = withContext(Dispatchers.IO) { runCatching { ScreenClient.exchange(at.first, at.second, payload) }.getOrNull() }?.let { Wire.decodeReply(it) }
        if (reply?.ok != true) return reply
        if (put.isNotEmpty()) dao.setDelivered(s.id, put.map { it.kds_id })
        val now = System.currentTimeMillis()
        for (m in reply.marks) runCatching { apply(s.id, m, now) }
        dao.saveScreenState(state.copy(epoch = reply.epoch, read_to = reply.seq, heard_at = now, trouble = null))
        return reply
    }

    private suspend fun apply(screen: String, m: WireMark, now: Long) {
        when {
            m.line != null && m.done != null -> kitchen.setDone(m.line, m.done, from = screen)
            m.ticket != null && m.bumped == true -> kitchen.bumpPart(m.ticket, screen, now)
            m.ticket != null && m.bumped == false -> kitchen.recallPart(m.ticket, screen)
        }
    }

    // Settings, Printers: asks a screen now and says in words how it answered.
    suspend fun test(screenId: String): String {
        val s = printing.screens().firstOrNull { it.id == screenId } ?: return "That kitchen screen is switched off or was removed."
        val reply = exchange(s)
        val waiting = db.service().partsOpen(s.id).count { !it.delivered }
        return Parts.trouble(s.name, s.address, reply, waiting) ?: "${Parts.called(s.name)} answered."
    }

    // How each screen stands, kept up to date from the till's own database.
    fun status(): Flow<Map<String, ScreenStatus>> = combine(db.service().screenStates(), db.service().partsOpenFlow()) { states, open ->
        val waiting = open.filter { !it.delivered }.groupingBy { it.screen_id }.eachCount()
        (states.map { it.screen_id } + waiting.keys).distinct().associateWith { id ->
            val s = states.firstOrNull { it.screen_id == id }
            ScreenStatus(answering = s != null && s.trouble == null && s.heard_at != null, waiting = waiting[id] ?: 0, trouble = s?.trouble, heardAt = s?.heard_at)
        }
    }

    private companion object {
        // with no screen to ask, how long before the till looks whether one was added
        const val LOOK_AGAIN = 15_000L
    }
}
