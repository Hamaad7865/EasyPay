package com.restopos.core.data

import java.time.LocalDate
import java.time.temporal.ChronoUnit

// A shop's customer accounts (server 0114), as arithmetic and words: nothing
// here reads the database, so each rule is unit-tested (AccountRulesTest) and
// the screens and the repository say the same thing.
object AccountRules {
    // <store>-<till>-A000001: one past the highest this till already has.
    fun prefix(store: String, till: String) = "$store-$till-A"

    fun next(store: String, till: String, have: List<String>): String {
        val p = prefix(store, till)
        val top = have.mapNotNull { n -> n.removePrefix(p).takeIf { n.startsWith(p) }?.takeWhile { it.isDigit() }?.toIntOrNull() }.maxOrNull() ?: 0
        return p + (top + 1).toString().padStart(6, '0')
    }

    // A bill ticked, as the split needs it: its id, its day and what it owes.
    data class Owing(val id: String, val day: String, val owed: Long)

    // What a payment puts on each bill ticked: oldest first, each up to what
    // it owes, so a part payment leaves the last ones part paid or untouched.
    // Bills that owe nothing are passed over. Bill id to amount, in order.
    fun split(amount: Long, ticked: List<Owing>): List<Pair<String, Long>> {
        var left = amount.coerceAtLeast(0)
        val out = ArrayList<Pair<String, Long>>()
        for (b in ticked.sortedWith(compareBy({ it.day }, { it.id }))) {
            if (left <= 0) break
            val take = minOf(left, b.owed.coerceAtLeast(0))
            if (take > 0) { out += b.id to take; left -= take }
        }
        return out
    }

    // Why a payment cannot be taken, or null.
    fun payError(amount: Long, ticked: Long): String? = when {
        ticked <= 0 -> "Tick the bills the customer is paying"
        amount <= 0 -> "Type how much"
        amount > ticked -> "That is more than the bills ticked come to"
        else -> null
    }

    // What a return of a sale on account takes off its bill: as much of the
    // refund as the bill still owes. The rest is money, as the shop's policy says.
    fun offBill(refund: Long, owed: Long): Long = minOf(refund.coerceAtLeast(0), owed.coerceAtLeast(0))

    fun age(day: String, today: LocalDate = LocalDate.now()): Long =
        runCatching { ChronoUnit.DAYS.between(LocalDate.parse(day), today) }.getOrDefault(0).coerceAtLeast(0)

    fun overdue(day: String, days: Int, today: LocalDate = LocalDate.now()) = age(day, today) > days

    // The ageing columns of a statement: 0–30, 31–60, 61–90, over 90 days.
    val BUCKETS = listOf("0-30 days", "31-60 days", "61-90 days", "Over 90 days")

    fun bucket(day: String, today: LocalDate = LocalDate.now()): Int = when (age(day, today)) {
        in 0..30 -> 0
        in 31..60 -> 1
        in 61..90 -> 2
        else -> 3
    }

    // Each bucket's total, for the bills given (id, day, owed).
    fun aged(bills: List<Owing>, today: LocalDate = LocalDate.now()): List<Long> {
        val out = LongArray(4)
        bills.forEach { if (it.owed > 0) out[bucket(it.day, today)] += it.owed }
        return out.toList()
    }
}
