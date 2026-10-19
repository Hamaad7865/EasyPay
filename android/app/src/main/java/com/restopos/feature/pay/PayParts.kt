package com.restopos.feature.pay

import com.restopos.core.common.Money

// What one payment is for, from how the bill is being paid.
//
// The owner: "Split pay option should be added - for example one customer
// total is 175 he wants to pay 100 by cash and 75 by juice". Split equally
// already took a bill in shares, each by its own payment type, and recorded
// them as one receipt; its shares were always equal. By amount, a part is
// what the cashier types, and what is not typed for is all that remains.
object PayParts {
    // full: all that remains. equal: a share of it among the guests still to
    // pay. items: the check that was picked. amount: the part typed (`piece`),
    // when it is less than what remains; else all that remains.
    fun amount(split: String, remaining: Long, guestsLeft: Int, picked: Long, piece: Long): Long = when (split) {
        "equal" -> Money.share(remaining, guestsLeft.coerceAtLeast(1))
        "items" -> picked
        "amount" -> if (piece in 1 until remaining) piece else remaining
        else -> remaining
    }

    // What is kept of an amount typed: itself when it leaves something to pay
    // after it, else 0, which stands for all that remains.
    fun piece(cents: Long, remaining: Long): Long = if (cents in 1 until remaining) cents else 0

    // A key of the pad: rupees, a point, two decimals; seven figures at most before the point.
    fun key(typed: String, k: String): String = when {
        k == "del" -> typed.dropLast(1)
        k == "." -> if (typed.contains('.')) typed else if (typed.isEmpty()) "0." else "$typed."
        typed.contains('.') -> if (typed.substringAfter('.').length >= 2) typed else typed + k
        typed == "0" -> k
        typed.length >= 7 -> typed
        else -> typed + k
    }

    // Shares already taken (`amounts`, in the order taken) against a bill that
    // is now `due`, no more than they come to: each share as what it keeps and
    // what of it is given back, the last shares first. The money is in the
    // drawer; it is recorded, never thrown away.
    fun covering(amounts: List<Long>, due: Long): List<Pair<Long, Long>> {
        var over = (amounts.sum() - due).coerceAtLeast(0)
        return amounts.asReversed().map { a ->
            val back = minOf(a, over)
            over -= back
            (a - back) to back
        }.asReversed()
    }

    fun cents(typed: String): Long {
        if (typed.isEmpty()) return 0
        val whole = typed.substringBefore('.').toLongOrNull() ?: 0
        val part = typed.substringAfter('.', "").padEnd(2, '0').take(2).toLongOrNull() ?: 0
        return whole * 100 + part
    }
}
