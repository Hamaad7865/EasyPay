package com.restopos.core.data

import com.restopos.core.database.PunchEntity

// Who a till's day closing clocks out. The owner: "Closing the day clocks out
// everyone who was clocked in". Someone who goes home without clocking out
// was left clocked in overnight, and their hours ran until they next came to
// the till; the day is over when the till says it is.
//
// It is everyone still clocked in WHO CLOCKED IN ON THIS TILL. A business
// with one tablet has no other, so that is everyone. Where a store has
// several tills, each closes its own day, and one till closing must not send
// home someone who clocked in at another and is still serving there.
object ClockOut {
    // The people to clock out, in the order they clocked in. punches: the
    // store's, oldest first, as the till keeps them; a removed one is not one.
    fun stillIn(punches: List<PunchEntity>, device: String): List<String> {
        val last = LinkedHashMap<String, PunchEntity>()
        punches.filter { it.deleted_at == null }.sortedBy { it.device_time }.forEach { p -> last.remove(p.employee_id); last[p.employee_id] = p }
        return last.values.filter { it.kind == "in" && (it.device_id == null || it.device_id == device) }.sortedBy { it.device_time }.map { it.employee_id }
    }

    // What the closing says of it: nothing when nobody was, "Aisha was clocked
    // out.", "Aisha and Ben were clocked out.", "Aisha, Ben and 2 others were clocked out."
    fun said(names: List<String>): String = when (names.size) {
        0 -> ""
        1 -> "${names[0]} was clocked out."
        2 -> "${names[0]} and ${names[1]} were clocked out."
        else -> "${names[0]}, ${names[1]} and ${names.size - 2} ${if (names.size == 3) "other" else "others"} were clocked out."
    }
}
