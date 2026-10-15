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
}
