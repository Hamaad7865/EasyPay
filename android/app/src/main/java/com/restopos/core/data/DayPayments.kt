package com.restopos.core.data

import com.restopos.core.database.PaymentRow
import com.restopos.core.print.DocAmount

// The figures of Settings, Payments: what each way of paying took since the
// day closing, and apart from them what moved no money (a sale on account, a
// credit note or a deposit used, goods given back in an exchange: Accounts.FIXED),
// kept out of the total as the X report keeps them out of its tenders. A sale
// on account was added in as money taken, and the page said more than the
// drawer and the card machine held.
object DayPayments {
    data class Figures(val money: List<DocAmount>, val total: Long, val noMoney: List<DocAmount>)

    fun signed(r: PaymentRow): Long = if (r.type == "refund") -r.amount else r.amount

    // names and kinds: each payment type's, by its id
    fun of(rows: List<PaymentRow>, names: Map<String, String>, kinds: Map<String, String>): Figures {
        fun byName(list: List<PaymentRow>) = list.groupBy { names[it.payment_type_id] ?: "Other" }
            .map { (name, l) -> DocAmount(name, l.sumOf { signed(it) }, l.size) }
            .sortedByDescending { it.amount }
        val (none, money) = rows.partition { kinds[it.payment_type_id] in Accounts.FIXED }
        val taken = byName(money)
        return Figures(taken, taken.sumOf { it.amount }, byName(none))
    }
}
