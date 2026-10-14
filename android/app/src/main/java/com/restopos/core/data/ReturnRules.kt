package com.restopos.core.data

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// A shop's return rules, as rules with nothing to do: the window, what the
// payment screen says of an exchange under each policy, what a credit note
// may cover, when it runs out, and which variants a returned line can be
// swapped for. The screens and the writers ask here.
object ReturnRules {
    private const val DAY = 24L * 3600 * 1000

    // Past the window the right to refund is needed; inside it whoever is at
    // the till returns alone. Whole days from the sale to now; a window of 0
    // is always past.
    fun pastWindow(soldAt: Long, now: Long, days: Int): Boolean = days == 0 || (now - soldAt) / DAY > days

    fun windowText(soldAt: Long, now: Long, days: Int): String =
        if (days == 0) "A return needs someone allowed to refund."
        else "This receipt is ${(now - soldAt) / DAY} days old, past the $days-day window. Someone allowed to refund must approve."

    // What Pay does with an exchange: the customer pays, nothing changes
    // hands, the sale is still short of the credit (exchange only), the rest
    // goes on a note (credit), or the shop gives money back (refund).
    sealed class PayState {
        data class Pay(val amount: Long) : PayState()
        object Even : PayState()
        data class Short(val needed: Long) : PayState()
        data class Note(val amount: Long) : PayState()
        data class Back(val amount: Long) : PayState()
    }

    fun payState(policy: String, saleTotal: Long, credit: Long): PayState {
        val due = saleTotal - credit
        return when {
            due > 0 -> PayState.Pay(due)
            due == 0L -> PayState.Even
            policy == "credit" -> PayState.Note(-due)
            policy == "refund" -> PayState.Back(-due)
            else -> PayState.Short(credit)
        }
    }

    // what a note with this much left may cover of what is due
    fun noteCover(balance: Long, due: Long): Long = minOf(balance, due).coerceAtLeast(0)

    fun validTo(issuedAt: Long, months: Int): LocalDate? =
        validTo(Instant.ofEpochMilli(issuedAt).atZone(ZoneId.systemDefault()).toLocalDate(), months)

    fun validTo(issued: LocalDate, months: Int): LocalDate? = if (months <= 0) null else issued.plusMonths(months.toLong())

    // a refund's number is STORE-TILL-R000012; the note it issues is STORE-TILL-CN000012
    fun noteNumber(refundNumber: String): String = refundNumber.replaceFirst("-R", "-CN")

    data class Variant(val id: String, val label: String, val gone: Boolean)

    // The other live variants of the returned line's product, one key each.
    fun swaps(returned: String?, variants: List<Variant>): List<Variant> =
        if (returned == null) emptyList() else variants.filter { it.id != returned && !it.gone }
}
