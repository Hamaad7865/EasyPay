package com.restopos.core.data

// When a takeaway or delivery for later rings before it is due (the owner,
// 2026-10-15: "if an order is due 21:00, we need the till to make a sound 10
// mins before", "configurable"). The rule only; DueReminders watches the
// board and rings.
//
// Only an order for later rings: one taken for a time further off than its
// usual time (the preparation time, twice it for a delivery: the due time an
// order is given when nobody chooses one) plus the reminder. An order taken
// for as soon as possible never does, nor one moved a few minutes later. When
// it was taken is read from its id (Uuid7.millis); an order whose id does not
// say is never rung for.
object DueReminder {
    class Order(
        val id: String,
        val label: String, // its number, "A-05"
        val name: String?, // who it is for
        val delivery: Boolean,
        val dueAt: Long?,
        val stage: String?, // new | kitchen | ready | done
        val noShow: Boolean,
        val takenAt: Long?,
    )

    private const val MINUTE = 60_000L

    // what is kept of an order once it has rung: its id and the due time it rang for
    fun key(o: Order): String = "${o.id}@${o.dueAt}"

    // The moment it rings; null when it never does.
    fun ringAt(o: Order, prepMinutes: Int, lead: Int): Long? {
        val due = o.dueAt ?: return null
        val taken = o.takenAt ?: return null
        if (lead <= 0) return null
        val usual = prepMinutes.toLong() * (if (o.delivery) 2 else 1)
        if (due - taken <= (usual + lead) * MINUTE) return null
        return due - lead * MINUTE
    }

    // still waiting on the kitchen: new, or in the kitchen, and not a no-show
    fun waiting(o: Order): Boolean = (o.stage == "new" || o.stage == "kitchen") && !o.noShow

    // The orders to ring for now: from their moment until they are due, once for each due time.
    fun toRing(orders: List<Order>, now: Long, prepMinutes: Int, lead: Int, rung: Set<String>): List<Order> = orders.filter { o ->
        val at = ringAt(o, prepMinutes, lead) ?: return@filter false
        waiting(o) && now >= at && now < o.dueAt!! && key(o) !in rung
    }

    // "A-05, Ravi, is due at 21:00: in 10 minutes"
    fun says(o: Order, now: Long, clock: (Long) -> String): String {
        val due = o.dueAt ?: return o.label
        val left = ((due - now + MINUTE - 1) / MINUTE).coerceAtLeast(1)
        val who = o.label + (o.name?.takeIf { it.isNotBlank() && it != o.label }?.let { ", $it," } ?: "")
        return "$who is due at ${clock(due)}: in $left minute" + if (left == 1L) "" else "s"
    }

    // What the tablet keeps of the orders it rang for, "key=due" by commas;
    // forgotten two days after they were due.
    fun keep(rung: Map<String, Long>, now: Long): String =
        rung.filterValues { it >= now - 2 * 24 * 60 * MINUTE }.entries.joinToString(",") { "${it.key}=${it.value}" }

    fun read(text: String?): Map<String, Long> = text.orEmpty().split(',').mapNotNull { e ->
        val i = e.lastIndexOf('=')
        if (i <= 0) null else e.substring(i + 1).toLongOrNull()?.let { e.substring(0, i) to it }
    }.toMap()
}
