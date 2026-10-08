package com.restopos.core.data

// Stock put in or taken out on the till: how much, as typed, and why, which
// need not be said. The server keeps quantities in thousandths, holds the
// floor (no more out than there is) and has the last word.
object StockForm {
    enum class Way(val code: String) { In("in"), Out("out") }
    class Reason(val code: String, val label: String)

    private val IN = listOf(Reason("receive", "Delivery"), Reason("found", "Found"))
    private val OUT = listOf(
        Reason("damaged", "Damaged"), Reason("expired", "Expired"), Reason("lost", "Lost"),
        Reason("internal", "Used here"), Reason("supplier_return", "Returned to supplier"),
    )
    // The reasons a direction may give (migration 0087). With none, the movement is an adjustment.
    fun reasons(way: Way): List<Reason> = if (way == Way.In) IN else OUT

    private val TYPED = Regex("""(\d{1,7})(?:[.,](\d{1,3}))?""")

    // A quantity as typed, in thousandths: "3", "1.5" or "1,5", above zero.
    // Null for anything else. The back office reads its own the same way.
    fun units(typed: String): Int? {
        val m = TYPED.matchEntire(typed.trim()) ?: return null
        val n = m.groupValues[1].toLong() * 1000 + m.groupValues[2].padEnd(3, '0').toLong()
        return if (n in 1..Int.MAX_VALUE) n.toInt() else null
    }

    fun after(now: Long, units: Int, way: Way): Long = if (way == Way.In) now + units else now - units

    // The server's refusal of stock.adjust, in words. left: what the till believes is there.
    fun refused(code: String?, shop: Boolean, left: String): String {
        val thing = if (shop) "product" else "item"
        return when (code) {
            "not-enough-stock" -> "There is not that much to take out" + if (left.isEmpty()) "." else ": $left."
            "not-counted" -> "The stock of this $thing is not counted. Switch on \"Count its stock\" first."
            "pick-variant" -> "This product has variants. Change the stock of one of them."
            "bad-variant" -> "That variant is no longer there."
            "bad-item" -> "That $thing is no longer there."
            "bad-store" -> "This till's store is no longer there. Set the till up again."
            "bad-qty" -> "Type how many, as a number above zero."
            "bad-reason" -> "That reason does not go with this. Pick another, or none."
            "forbidden" -> "You are not allowed to change stock. Ask a manager."
            "unknown-op" -> "The server has to be updated before stock can be changed from a till."
            null -> "The server refused it."
            else -> "The server refused it ($code)."
        }
    }
}
