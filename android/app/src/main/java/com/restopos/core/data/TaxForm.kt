package com.restopos.core.data

// A tax as a till's own sheet makes or changes it (server 0094): its name,
// its rate, whether prices already include it or it is added on top, and
// whether it is the usual one. The rules are the back office's Taxes page's.
// The server checks all of it again and has the last word; reading it here
// catches a slip before the tablet asks, and puts the server's refusals in
// the till's words. A tax is never removed, here as there.
object TaxForm {
    // usual: it becomes the usual tax. Never switched off, only moved onto another.
    data class Tax(val name: String, val rateBp: Int, val added: Boolean, val usual: Boolean)

    private val RATE = Regex("""(\d{1,3})(?:[.,](\d{1,2}))?""")

    // "15", "12.5" or "7,25" as hundredths of a percent, from 0 to 100. Null for anything else.
    fun rateBp(typed: String): Int? {
        val m = RATE.matchEntire(typed.trim().removeSuffix("%").trim()) ?: return null
        val bp = m.groupValues[1].toInt() * 100 + m.groupValues[2].padEnd(2, '0').toInt()
        return bp.takeIf { it in 0..10000 }
    }

    // 1500 as "15", 1250 as "12.5", 725 as "7.25"
    fun rate(bp: Int): String = when {
        bp % 100 == 0 -> (bp / 100).toString()
        bp % 10 == 0 -> "${bp / 100}.${bp % 100 / 10}"
        else -> "%d.%02d".format(bp / 100, bp % 100)
    }

    // What the sheet holds, read as a tax, or why it is not one yet.
    fun read(name: String, rate: String, added: Boolean, usual: Boolean): Result<Tax> = runCatching {
        val called = name.trim().take(30)
        require(called.isNotEmpty()) { "Give the tax a name" }
        val bp = rateBp(rate) ?: throw IllegalArgumentException("The rate is a percentage between 0 and 100")
        Tax(called, bp, added, usual)
    }

    // "15% · included in the price"
    fun says(rateBp: Int, type: String): String = "${rate(rateBp)}% · " + if (type == "added") "added on top" else "included in the price"

    // The server's refusal of tax.save, in words.
    fun refused(code: String?): String = when (code) {
        "name-taken" -> "Another tax already has that name."
        "name-required" -> "Give the tax a name"
        "bad-rate" -> "The rate is a percentage between 0 and 100"
        "bad-tax" -> "That tax is no longer there."
        "conflict" -> "That did not work. Close this and try again."
        "forbidden" -> "You are not allowed to change the taxes. Ask a manager."
        "unknown-op" -> "The server has to be updated before taxes can be changed from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}
