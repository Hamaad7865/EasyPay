package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.database.KdsTicketEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

// The kitchen display. Every send of an order is one ticket on it: the same
// lines the kitchen printer gets on one paper. The cooks tick lines off, bump
// the ticket when it is at the pass, and can call the last one back.
// A takeaway or delivery follows its tickets along the board: in the kitchen
// once it is sent, ready once its last ticket is bumped.
@Singleton
class Kitchen @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val tickets: TicketRepository,
    @ApplicationContext private val context: Context,
) {
    private fun op(type: String, payload: JsonObject) = OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())

    // The ticket a send will go on. Made before the send is recorded, so the
    // day's ticket number is taken outside the database transaction.
    suspend fun prepare(ticketId: String): KdsTicketEntity? {
        val t = db.tickets().ticket(ticketId) ?: return null
        val table = t.table_id?.let { db.tables().table(it)?.name }
        val type = t.dining_option_id?.let { db.ops().dining(it) }
        return KdsTicketEntity(
            Uuid7.next(), ticketId, session.nextNumber("K"), table ?: t.order_no ?: t.name ?: "Counter",
            type?.name ?: if (table != null) "Dine-in" else "Counter", t.covers.takeIf { table != null },
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

    // A cook taps a line: done, or not done after all.
    suspend fun toggle(lineId: String) {
        val line = db.tickets().line(lineId) ?: return
        db.withTransaction {
            db.service().setKitchenDone(lineId, !line.kitchen_done)
            mark(listOf(lineId), if (line.kitchen_done) "sent" else "done")
        }
        pushNow(context)
    }

    // Bump: the ticket is at the pass and leaves the screen.
    suspend fun bump(kdsId: String): String? {
        val k = db.service().kds(kdsId) ?: return null
        val lines = db.service().linesOfKds(kdsId).map { it.id }
        db.withTransaction {
            db.service().setBumped(kdsId, System.currentTimeMillis())
            mark(lines, "bumped")
        }
        if (db.tickets().ticket(k.ticket_id)?.stage == "kitchen" && db.service().kdsOpenFor(k.ticket_id) == 0) {
            tickets.setStage(k.ticket_id, "ready")
        }
        pushNow(context)
        return k.label
    }

    // Recall: the ticket bumped last comes back, as it was.
    suspend fun recall(): String? {
        val k = db.service().lastBumped(System.currentTimeMillis() - 12 * 3_600_000L) ?: return null
        val lines = db.service().linesOfKds(k.id)
        db.withTransaction {
            db.service().setBumped(k.id, null)
            mark(lines.filter { !it.kitchen_done }.map { it.id }, "sent")
            mark(lines.filter { it.kitchen_done }.map { it.id }, "done")
        }
        if (db.tickets().ticket(k.ticket_id)?.stage == "ready") tickets.setStage(k.ticket_id, "kitchen")
        pushNow(context)
        return k.label
    }

    // Tickets from days gone by are of no use to anyone.
    suspend fun prune() = db.service().pruneKds(System.currentTimeMillis() - 3 * 24 * 3_600_000L)
}
