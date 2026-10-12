package com.restopos.core.guest

import com.restopos.core.data.TicketRepository
import com.restopos.core.database.GuestOrderEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

// "There is an answer for the ordering site": said by whoever wrote it down,
// heard by GuestLink, which sends what the site has not been told. Kept until
// it is heard, and heard once however often it was said.
@Singleton
class GuestKick @Inject constructor() {
    private val asked = Channel<Unit>(Channel.CONFLATED)
    fun now() { asked.trySend(Unit) }
    suspend fun await() { asked.receive() }
}

// An order from a table as the cashier is shown it: which table, when, and
// either its lines at the till's own names and prices or why it cannot be
// taken as it is.
data class GuestShown(val id: String, val table: String, val tableName: String, val placedAt: Long, val checked: Checked)

// How many orders wait for an answer, and how many of those nobody at the
// till has looked at yet: the number on the top bar's phone key. The owner:
// "the phone icon should show like a 1 above, if unseen and then another QR
// order, then 2 and goes on".
data class GuestCount(val waiting: Int = 0, val fresh: Int = 0)

object GuestSeen {
    // waiting: the ids of the orders that wait; seen: the ones the list was opened on
    fun count(waiting: List<String>, seen: Set<String>) = GuestCount(waiting.size, waiting.count { it !in seen })
}

// The orders guests sent from their tables, on the till: the ones that wait,
// and the cashier's answer. Accepting puts the lines on the table's order, as
// if they had been rung up there (seating the table when it was free), and
// opens that order on the register for Send to kitchen as usual. The till's
// own menu decides every name and price (GuestCheck).
@Singleton
class GuestBook @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val tickets: TicketRepository,
    private val kick: GuestKick,
) {
    suspend fun book(): MenuBook {
        val g = db.guest()
        val tables = session.storeId()?.let { db.tables().tablesNow(it) }.orEmpty()
        val groups = g.groups().associateBy { it.id }
        return MenuBook(
            tables = tables.associate { it.id to it.name },
            items = g.items().associateBy { it.id },
            groupsOf = g.links().groupBy({ it.item_id }, { groups[it.group_id] }).mapValues { (_, of) -> of.filterNotNull() },
            optionsOf = g.options().groupBy { it.group_id },
        )
    }

    private fun GuestOrderEntity.asOrder() = GuestOrder(id, placed_at, table_id, GuestWire.lines(lines))

    // What waits, looked at again whenever the menu changes: a dish that sold
    // out since the order came is said so before the cashier taps Accept.
    fun waiting(): Flow<List<GuestShown>> = combine(db.guest().waiting(), db.guest().pulse()) { rows, _ ->
        if (rows.isEmpty()) emptyList()
        else {
            val book = book()
            rows.map { r -> GuestShown(r.id, r.table_id, book.tables[r.table_id] ?: "A table", r.placed_at, GuestCheck.of(r.asOrder(), book)) }
        }
    }

    // The orders the list was opened on. Kept while the till runs and no
    // longer: after the app is started again every order that still waits
    // counts as new, which it is to whoever starts the till.
    private val seen = MutableStateFlow<Set<String>>(emptySet())
    fun looked(ids: Collection<String>) { if (ids.isNotEmpty()) seen.update { it + ids } }
    fun count(): Flow<GuestCount> = combine(db.guest().waiting(), seen) { rows, s -> GuestSeen.count(rows.map { it.id }, s) }

    // Accepts it: all of its lines go on the table's order, or none do and the
    // cashier is told why. Answers the table's id, whose order is now the one
    // on the register.
    suspend fun accept(id: String): Result<String> = runCatching {
        val row = db.guest().order(id)?.takeIf { it.status == "waiting" } ?: error("This order was already answered.")
        val ready = when (val c = GuestCheck.of(row.asOrder(), book())) {
            is Checked.Fault -> error(c.why)
            is Checked.Ready -> c
        }
        tickets.openTable(ready.table)
        for (l in ready.lines) tickets.addItem(l.item.id, l.thousandths, l.mods, l.note).getOrThrow()
        if (db.guest().answer(id, "accepted", null, System.currentTimeMillis()) > 0) kick.now()
        ready.table
    }

    // Declines it, with what the guest is told on their phone.
    suspend fun decline(id: String, reason: String): Result<Unit> = runCatching {
        if (db.guest().answer(id, "declined", reason.trim().take(140).ifEmpty { null }, System.currentTimeMillis()) > 0) kick.now()
    }
}
