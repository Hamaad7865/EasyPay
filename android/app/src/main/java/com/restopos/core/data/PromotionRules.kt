package com.restopos.core.data

import com.restopos.core.common.Money

// A shop's promotions as rules with nothing to do (server 0110): never below
// the line's cost, a real reduction, what breaks even after VAT, and which
// lines are slow movers or promotions that still do not sell. The screen and
// the writer ask here; the server holds the same rules.
object PromotionRules {
    private const val DAY = 24L * 3600 * 1000

    // Why a markdown to `asked` cannot be applied to a line at `current` that cost `cost`; null when it can.
    fun check(cost: Long?, current: Long, asked: Long): String? = when {
        cost == null -> "Set a cost for it first: a promotion can never go below cost, and its cost is not known."
        asked < 0 -> "That is not a price."
        asked < cost -> "Below cost (${Money.format(cost)}): that would sell at a loss."
        asked >= current -> "Must be lower than the current price (${Money.format(current)}) to be a promotion."
        else -> null
    }

    // reducing again: lower than the promotion price, and still not below cost
    fun reduceCheck(cost: Long?, promo: Long, asked: Long): String? = when {
        cost == null -> "Set a cost for it first."
        asked < 0 -> "That is not a price."
        asked < cost -> "Below cost (${Money.format(cost)}): that would sell at a loss."
        asked >= promo -> "Must be lower than the promotion price (${Money.format(promo)})."
        else -> null
    }

    // the price that breaks even once VAT is paid out of it: cost grossed up by the rate (basis points); null with no VAT in the price
    fun breakEven(cost: Long, rateBp: Int, included: Boolean): Long? =
        if (rateBp <= 0 || !included) null else (cost * (10000L + rateBp) + 5000) / 10000

    // the soft warning: above cost, but under what breaks even after VAT
    fun warn(cost: Long?, rateBp: Int, included: Boolean, asked: Long): String? {
        if (cost == null) return null
        val be = breakEven(cost, rateBp, included) ?: return null
        return if (asked >= cost && asked < be) "Above cost, but below the ${Money.format(be)} that breaks even after VAT: you keep less than it cost once VAT is paid." else null
    }

    data class Line(val itemId: String, val variantId: String, val qty: Int, val madeAt: Long, val lastSold: Long?, val onPromotion: Boolean, val appliedAt: Long? = null)

    // A line with stock, no live promotion, and no sale for `days`: counted
    // from the day it was made when it never sold. Oldest first.
    fun slowMovers(lines: List<Line>, now: Long, days: Int): List<Line> =
        lines.filter { it.qty > 0 && !it.onPromotion && (now - idleSince(it)) / DAY >= maxOf(days, 1) }.sortedBy { idleSince(it) }

    // A live promotion whose line still has stock and sold nothing for `days`
    // since it was applied or since its last sale, whichever came later.
    fun stale(lines: List<Line>, now: Long, days: Int): List<Line> =
        lines.filter { it.onPromotion && it.qty > 0 && (now - maxOf(it.appliedAt ?: 0, it.lastSold ?: 0)) / DAY >= maxOf(days, 1) }

    fun idleSince(l: Line): Long = maxOf(l.madeAt, l.lastSold ?: 0)
    fun daysIdle(l: Line, now: Long): Int = ((now - idleSince(l)) / DAY).toInt()
}
