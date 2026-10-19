package com.restopos.core.sync

import com.restopos.core.database.OutboxEntity

// A change the server refused, sent again from the Rejected screen (once what
// made it refuse is put right: a setting changed, the server updated). Until
// now the screen could only remove it, and removing it removed the only copy
// that could ever reach the server: the sale stayed on this tablet alone.
object Refused {
    // The server keeps its answer to every change by its id (sync_ops_applied),
    // so the same id would only be refused again: it goes under a new one. What
    // it carries, who did it and when stay as they were; the time keeps its
    // place in the queue.
    fun again(row: OutboxEntity, newId: String): OutboxEntity =
        row.copy(op_id = newId, state = "pending", last_error = null, attempts = row.attempts + 1)

    // Several sent again together, in the order they were made: an order
    // refused at its start refuses each change after it, and those go up
    // after it. Each with the id it had.
    fun allAgain(rows: List<OutboxEntity>, newId: () -> String): List<Pair<String, OutboxEntity>> =
        rows.sortedBy { it.created_at }.map { it.op_id to again(it, newId()) }
}
