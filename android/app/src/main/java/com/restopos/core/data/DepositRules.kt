package com.restopos.core.data

import java.time.LocalDate
import java.time.temporal.ChronoUnit

// A shop's deposits (server 0113), as arithmetic and words: nothing here
// reads the database, so each rule is unit-tested (DepositRulesTest) and the
// screens and the repository say the same thing.
object DepositRules {
    // The next number this till gives: one past the highest it already has,
    // so a tablet restored from a backup, or moved to a new one, counts on.
    // <store>-<till>-D000001.
    fun prefix(store: String, till: String) = "$store-$till-D"

    fun next(store: String, till: String, have: List<String>): String {
        val p = prefix(store, till)
        val top = have.mapNotNull { n -> n.removePrefix(p).takeIf { n.startsWith(p) }?.takeWhile { it.isDigit() }?.toIntOrNull() }.maxOrNull() ?: 0
        return p + (top + 1).toString().padStart(6, '0')
    }

    // What the customer still owes: what the goods not collected yet come to,
    // less the money paid on the deposit and not used yet. The goods' share of
    // the total is by their lines (full: every line at its quantity, left: at
    // what is still held), so a tax added on top is in it too. Before anything
    // is collected it is the total less what is free, which is what was paid.
    fun toPay(total: Long, full: Long, left: Long, free: Long): Long {
        val owed = when {
            full <= 0 || left <= 0 -> 0L
            left >= full -> total
            else -> (total * left + full / 2) / full
        }
        return (owed - free.coerceAtLeast(0)).coerceAtLeast(0)
    }

    // What a collection's bill takes from the deposit: what is free, at most
    // the bill.
    fun cover(free: Long, bill: Long): Long = minOf(free.coerceAtLeast(0), bill.coerceAtLeast(0))

    // Days past the collect-by date (0 or less: not overdue), by whole days.
    fun daysOver(collectBy: String, today: LocalDate = LocalDate.now()): Long =
        runCatching { ChronoUnit.DAYS.between(LocalDate.parse(collectBy), today) }.getOrDefault(0)

    fun overdue(collectBy: String, today: LocalDate = LocalDate.now()) = daysOver(collectBy, today) > 0

    // Past the date and the grace days after it: cancelled by itself when the
    // shop says so. The server's rule (deposits_expire): collect_by + grace < today.
    fun expired(collectBy: String, grace: Int, today: LocalDate = LocalDate.now()) = daysOver(collectBy, today) > grace

    // The date offered when a deposit is taken.
    fun collectBy(days: Int, today: LocalDate = LocalDate.now()): String = today.plusDays(days.coerceIn(1, 365).toLong()).toString()

    // A credit note from a cancelled deposit: its number is the deposit's with -CN.
    fun noteNumber(deposit: String) = "$deposit-CN"

    fun noteValidTo(months: Int, today: LocalDate = LocalDate.now()): String? = if (months <= 0) null else today.plusMonths(months.toLong()).toString()

    // The sentence on the slip that says what happens if the goods are not collected.
    fun slipSentence(cancel: String, overdue: String, grace: Int): String {
        val money = when (cancel) {
            "refund" -> "the deposit is given back"
            "keep" -> "the deposit is kept by the shop"
            else -> "the deposit is given back as a credit note"
        }
        return if (overdue == "cancel") {
            val after = if (grace == 0) "by the date" else "within $grace day${if (grace == 1) "" else "s"} of the date"
            "If not collected $after, the goods go back on sale and $money."
        } else "If you cancel, $money."
    }

    // What a cancel does with the money, in the cashier's words.
    fun outcomeWords(outcome: String, amount: String): String = when (outcome) {
        "refund" -> "Give back $amount"
        "keep" -> "The shop keeps $amount"
        else -> "Credit note for $amount"
    }

    // What the deposit's state is called on the list.
    fun stateWords(status: String, owed: Long, overdueDays: Long): String = when {
        status == "open" && overdueDays > 0 -> "Overdue $overdueDays day${if (overdueDays == 1L) "" else "s"}"
        status == "open" -> "Open"
        owed > 0 -> "To give back"
        status == "collected" -> "Collected"
        else -> "Cancelled"
    }

    // The rule a customer must meet when the shop asks for one.
    fun customerMissing(required: Boolean, name: String?, phone: String?): String? = when {
        !required -> null
        name.isNullOrBlank() -> "Pick the customer: a deposit is kept under their name"
        phone.isNullOrBlank() -> "Add the customer's phone: the shop calls them when it is time to collect"
        else -> null
    }

    // How much may be paid now: from 0 (the goods only held) to what is left to pay.
    fun payNowError(amount: Long, toPay: Long): String? = when {
        amount < 0 -> "Type how much"
        amount > toPay -> "That is more than the ${com.restopos.core.common.Money.format(toPay)} left to pay"
        else -> null
    }

    // Money handed back on a cancel: by default in the tenders it came in,
    // newest first, never more than each brought in. Each pair: type, amount.
    fun backSplit(free: Long, cameIn: List<Pair<String, Long>>): List<Pair<String, Long>> {
        var left = free.coerceAtLeast(0)
        val out = ArrayList<Pair<String, Long>>()
        for ((type, amount) in cameIn.asReversed()) {
            if (left <= 0) break
            val take = minOf(left, amount)
            if (take > 0) { out += type to take; left -= take }
        }
        return out.groupBy { it.first }.map { (t, xs) -> t to xs.sumOf { it.second } }
    }
}
