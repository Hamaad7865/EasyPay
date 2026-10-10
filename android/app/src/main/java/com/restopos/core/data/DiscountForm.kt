package com.restopos.core.data

import com.restopos.core.common.Money

// A discount as a till's own sheet makes or changes it (server 0095): its
// name, which prints on the receipt, a percentage of the bill or an amount
// off it, and whether giving it needs a manager.
object DiscountForm {
    // value: whole percents, or cents
    data class Discount(val name: String, val percent: Boolean, val value: Long, val needsManager: Boolean)

    fun read(name: String, percent: Boolean, value: String, needsManager: Boolean): Result<Discount> = runCatching {
        val called = name.trim().take(40)
        require(called.isNotEmpty()) { "Give the discount a name: it is what prints on the receipt" }
        val v = if (percent) {
            value.trim().removeSuffix("%").trim().toLongOrNull()?.takeIf { it in 1..100 } ?: throw IllegalArgumentException("A percentage is a whole number from 1 to 100")
        } else {
            val cents = Money.parseRs(value) ?: throw IllegalArgumentException("Say how much the discount takes off")
            require(cents >= 1) { "Say how much the discount takes off" }
            require(cents <= 100_000_000L) { "That amount is too large" }
            cents
        }
        Discount(called, percent, v, needsManager)
    }

    // "20% off", "Rs 50.00 off"
    fun says(type: String, value: Long): String = if (type == "percent") "$value% off" else Money.format(value) + " off"

    fun refused(code: String?): String = when (code) {
        "name-required" -> "Give the discount a name: it is what prints on the receipt"
        "name-taken" -> "Another discount already has that name."
        "bad-value" -> "A percentage is a whole number from 1 to 100; an amount is more than nothing."
        "bad-discount" -> "That discount is no longer there."
        "forbidden" -> "You are not allowed to change the discounts. Ask a manager."
        "conflict" -> "That did not work. Close this and try again."
        "unknown-op" -> "The server has to be updated before discounts can be changed from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}
