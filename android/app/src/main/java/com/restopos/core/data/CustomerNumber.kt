package com.restopos.core.data

// The number a customer is called by when the order is ready (the owner,
// 2026-10-15: "customer number 01 ... closing the register resets this
// number"). One count on each till, from 1, back to 1 when the till's day is
// closed (SessionStore.nextCustomer, dayClosed). It is kept in the order's
// number with the letter of its kind in front: C-01 at the counter, A-05 a
// takeaway, D-12 a delivery. An order at a table has none.
object CustomerNumber {
    fun label(letter: String, n: Int): String = "$letter-${n.toString().padStart(2, '0')}"

    // the number alone, as the papers print it: "05" of "A-05"; null when the order has none
    fun digits(orderNo: String?): String? =
        orderNo?.substringAfterLast('-', "")?.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }

    // What the papers print large: a restaurant's order with no table. A
    // shop's sales are counted the same way but its receipts print no number
    // (asked for the restaurant, 2026-10-15); a table is served where it sits.
    fun onPaper(orderNo: String?, tableId: String?, retail: Boolean): String? =
        if (retail || tableId != null) null else digits(orderNo)

    // the same number under the letter of another kind: C-05 becomes A-05
    fun relabel(orderNo: String, letter: String): String = digits(orderNo)?.let { "$letter-$it" } ?: orderNo

    // The numbers open orders are called by, whatever their letter: the papers
    // print the number alone, so A-03 and C-03 are both "03".
    fun held(orderNos: List<String?>): Set<Int> = orderNos.mapNotNull { digits(it)?.toIntOrNull() }.toSet()

    // The next number from the till's count, stepping over the ones open orders
    // hold. Orders left unpaid when a day is closed go on into the next one with
    // their numbers while the count starts again at 01, so the new day's third
    // takeaway was A-03 beside yesterday's A-03 still waiting.
    suspend fun next(held: Set<Int>, take: suspend () -> Int): Int {
        var n = take()
        while (n in held) n = take()
        return n
    }
}
