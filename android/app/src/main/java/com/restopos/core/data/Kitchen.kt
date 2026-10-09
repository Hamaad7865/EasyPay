package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.database.KdsOutEntity
import com.restopos.core.database.KdsTicketEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.TicketEntity
import com.restopos.core.database.TicketLineEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.kitchen.Parts
import com.restopos.core.kitchen.ScreenKick
import com.restopos.core.kitchen.Wire
import com.restopos.core.kitchen.WireMark
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

// What the kitchen is told besides the items: the order's remark, and for a
// takeaway or delivery who to ring and where it goes. The same words on the
// kitchen's paper and on a kitchen screen.
internal fun kitchenRemark(t: TicketEntity): String? =
    listOfNotNull(t.note, t.phone?.let { "Tel $it" }, t.address).joinToString(" · ").ifEmpty { null }

// The kitchen display. Every send of an order is one ticket on it: the same
// lines the kitchen printer gets on one paper. The cooks tick lines off, bump
// the ticket when it is at the pass, and can call the last one back.
// A takeaway or delivery follows its tickets along the board: in the kitchen
// once it is sent, ready once its last ticket is bumped.
//
// A restaurant may also have kitchen screens: tablets in the kitchen, each
// shown its own part of a ticket (core/kitchen). What the cooks do there
// arrives here (setDone, bumpPart, recallPart) and is recorded as a tap on
// this till's own Kitchen screen is; what is done on this till's screen, and
// a void, is owed to the screens that hold the line (kds_out) and sent to
// them by ScreenLink. This till stays the one place that tells the server.
@Singleton
class Kitchen @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val tickets: TicketRepository,
    private val kick: ScreenKick,
    @ApplicationContext private val context: Context,
) {
    private fun op(type: String, payload: JsonObject) = OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())

    // The ticket a send will go on. Made before the send is recorded, so the
    // day's ticket number is taken outside the database transaction.
    suspend fun prepare(ticketId: String): KdsTicketEntity? {
        val t = db.tickets().ticket(ticketId) ?: return null
        val table = t.table_id?.let { db.tables().table(it)?.name }
        val type = t.dining_option_id?.let { db.ops().dining(it) }
        val waiter = t.opened_by?.let { db.staff().employee(it)?.name } ?: staff.current.value?.employee?.name
        return KdsTicketEntity(
            Uuid7.next(), ticketId, session.nextNumber("K"), table ?: t.order_no ?: t.name ?: "Counter",
            type?.name ?: if (table != null) "Dine-in" else "Counter", t.covers.takeIf { table != null },
            waiter = waiter, remark = kitchenRemark(t),
        )
    }

    // Called inside the transaction that marks the lines as sent.
    suspend fun put(ticket: KdsTicketEntity?, lineIds: List<String>) {
        if (ticket == null || lineIds.isEmpty()) return
        db.service().upsertKds(ticket)
        db.service().putOnKds(lineIds, ticket.id)
    }

    // A takeaway that has just gone to the kitchen moves along the board.
    suspend fun afterSend(ticketId: String) {
        if (db.tickets().ticket(ticketId)?.stage == "new") tickets.setStage(ticketId, "kitchen")
    }

    private suspend fun mark(lineIds: List<String>, status: String) {
        if (lineIds.isEmpty()) return
        db.outbox().enqueue(op("kitchen.mark", buildJsonObject {
            put("status", status)
            put("line_ids", buildJsonArray { lineIds.forEach { add(it) } })
        }))
    }

    // A mark is owed to every kitchen screen that has a part of the ticket,
    // and for a line's mark holds that line; not to the screen it came from.
    private suspend fun owe(kdsId: String?, mark: WireMark, from: String? = null) {
        if (kdsId == null) return
        val to = db.service().partsOf(kdsId).filter { it.screen_id != from && (mark.line == null || Parts.lineIds(it).contains(mark.line)) }
        if (to.isNotEmpty()) db.service().addOut(to.map { KdsOutEntity(screen_id = it.screen_id, mark = Wire.encodeMark(mark)) })
    }

    // A cook taps a line on this till's Kitchen screen: done, or not done after all.
    suspend fun toggle(lineId: String) {
        val line = db.tickets().line(lineId) ?: return
        setDone(lineId, !line.kitchen_done)
    }

    // A line is done, or is not: said on this till's screen, or by a kitchen
    // screen (`from`, which is then not told what it said itself). Said
    // again, it changes nothing and tells nobody.
    suspend fun setDone(lineId: String, done: Boolean, from: String? = null) {
        val line = db.tickets().line(lineId) ?: return
        if (line.kitchen_done == done) return
        db.withTransaction {
            db.service().setKitchenDone(lineId, done)
            mark(listOf(lineId), if (done) "done" else "sent")
            owe(line.kds_id, WireMark(line = lineId, done = done), from)
        }
        pushNow(context)
        kick.now()
    }

    // A line the kitchen already has was voided: the screens that hold it
    // show it struck through. The kitchen's paper gets its VOID ticket as before.
    suspend fun voided(line: TicketLineEntity) {
        if (line.kds_id == null) return
        owe(line.kds_id, WireMark(line = line.id, voided = true))
        kick.now()
    }

    private val _ready = MutableSharedFlow<String>(extraBufferCapacity = 16)
    // A takeaway or delivery the kitchen has just finished: what it is called
    // ("A-12"). The till says so with a sound, whichever of its screens is
    // open, and counts it on the Takeaway key until it is handed over.
    val ready: SharedFlow<String> = _ready

    // The ticket leaves this till's screen; a takeaway whose last ticket it
    // was is marked ready.
    private suspend fun done(kdsId: String, ticketId: String) {
        val t = db.tickets().ticket(ticketId) ?: return
        if (t.stage == "kitchen" && db.service().kdsOpenFor(ticketId) == 0) {
            tickets.setStage(ticketId, "ready")
            // The sound is made here and not by whichever screen is open: a
            // till that has locked itself still hears from its kitchen
            // screens, and whoever is near it should hear that the food is up.
            com.restopos.core.common.Chime.ready()
            _ready.tryEmit(t.order_no ?: t.name ?: "A takeaway")
        }
    }

    // Bump on this till's Kitchen screen: the whole ticket is at the pass and
    // leaves the screen, and every kitchen screen's part of it with it.
    suspend fun bump(kdsId: String): String? {
        val k = db.service().kds(kdsId) ?: return null
        val lines = db.service().linesOfKds(kdsId).map { it.id }
        val now = System.currentTimeMillis()
        db.withTransaction {
            db.service().setBumped(kdsId, now)
            db.service().setPartsBumped(kdsId, now)
            mark(lines, "bumped")
            owe(kdsId, WireMark(ticket = kdsId, bumped = true))
        }
        done(kdsId, k.ticket_id)
        pushNow(context)
        kick.now()
        return k.label
    }

    // Bump on a kitchen screen: that screen's part is at the pass. Another
    // screen's part of the same ticket stays where it is. The ticket leaves
    // this till's screen when every part of it has been bumped (Parts).
    suspend fun bumpPart(kdsId: String, screenId: String, at: Long) {
        val k = db.service().kds(kdsId) ?: return
        val part = db.service().partsOf(kdsId).firstOrNull { it.screen_id == screenId } ?: return
        if (part.bumped_at != null) return
        val mine = Parts.lineIds(part).toSet()
        val lines = db.service().linesOfKds(kdsId).filter { it.id in mine }.map { it.id }
        var all = false
        db.withTransaction {
            db.service().setPartBumped(kdsId, screenId, at)
            mark(lines, "bumped")
            all = Parts.ticketBumped(db.service().partsOf(kdsId))
            if (all) db.service().setBumped(kdsId, at)
        }
        if (all) done(kdsId, k.ticket_id)
        pushNow(context)
    }

    // Recall on this till's Kitchen screen: the ticket bumped last comes
    // back, as it was, on this screen and on every kitchen screen's.
    suspend fun recall(): String? {
        val k = db.service().lastBumped(System.currentTimeMillis() - 12 * 3_600_000L) ?: return null
        val lines = db.service().linesOfKds(k.id)
        db.withTransaction {
            db.service().setBumped(k.id, null)
            db.service().setPartsBumped(k.id, null)
            mark(lines.filter { !it.kitchen_done }.map { it.id }, "sent")
            mark(lines.filter { it.kitchen_done }.map { it.id }, "done")
            owe(k.id, WireMark(ticket = k.id, bumped = false))
        }
        if (db.tickets().ticket(k.ticket_id)?.stage == "ready") tickets.setStage(k.ticket_id, "kitchen")
        pushNow(context)
        kick.now()
        return k.label
    }

    // Recall on a kitchen screen: its part is back on it, and the ticket is
    // back on this till's screen.
    suspend fun recallPart(kdsId: String, screenId: String) {
        val k = db.service().kds(kdsId) ?: return
        val part = db.service().partsOf(kdsId).firstOrNull { it.screen_id == screenId } ?: return
        if (part.bumped_at == null) return
        val mine = Parts.lineIds(part).toSet()
        val lines = db.service().linesOfKds(kdsId).filter { it.id in mine }
        db.withTransaction {
            db.service().setPartBumped(kdsId, screenId, null)
            db.service().setBumped(kdsId, null)
            mark(lines.filter { !it.kitchen_done }.map { it.id }, "sent")
            mark(lines.filter { it.kitchen_done }.map { it.id }, "done")
        }
        if (db.tickets().ticket(k.ticket_id)?.stage == "ready") tickets.setStage(k.ticket_id, "kitchen")
        pushNow(context)
    }

    // Tickets from days gone by are of no use to anyone, nor what a screen
    // was owed of them.
    suspend fun prune() {
        val before = System.currentTimeMillis() - 3 * 24 * 3_600_000L
        db.service().pruneKds(before)
        db.service().pruneParts(before)
    }
}
