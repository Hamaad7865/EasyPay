package com.restopos.core.data

import com.restopos.core.common.Money

// Loyalty points (server 0128): a percentage of what a customer pays comes
// back to them as points, and a point is a rupee, so a balance is kept and
// said as money. Spent on Pay as the "Points" discount. A refund takes back
// its share of what its sale earned and gives back its share of what it
// used. Amounts in cents, as everywhere.
object LoyaltyRules {
    // The smallest amount the business shows: whole rupees, tens of cents, cents.
    private fun unit(decimals: Int): Long = when (decimals) { 0 -> 100L; 1 -> 10L; else -> 1L }

    // What a receipt of `total` (after every discount, the points included)
    // earns at `bp` basis points (100 is 1%): never rounded up, and in the
    // business's own smallest amount.
    fun earned(total: Long, bp: Int, decimals: Int = Money.decimals): Long {
        if (total <= 0 || bp <= 0) return 0
        val u = unit(decimals)
        return total * bp / 10000 / u * u
    }

    // The most of `balance` that can come off a bill of `base` (what it comes
    // to before the points, after any other discount).
    fun most(balance: Long, base: Long, decimals: Int = Money.decimals): Long {
        val u = unit(decimals)
        return (minOf(balance, base).coerceAtLeast(0)) / u * u
    }

    // A refund's share of a sale's `points` (what it earned, or what it used):
    // the refund's subtotal `sub` over the sale's `ofSub`, rounded half up.
    // The refund that completes the sale (`last`) takes all that is `left`,
    // so the sale ends with every point settled; no refund takes more.
    fun share(points: Long, sub: Long, ofSub: Long, last: Boolean, left: Long): Long {
        if (left <= 0 || points <= 0) return 0
        if (last) return left
        if (ofSub <= 0 || sub <= 0) return 0
        val part = (points * sub * 2 + ofSub) / (ofSub * 2)
        return part.coerceIn(0, left)
    }

    // A card made by EasyPay: EP and ten digits. A product's barcode is
    // digits only, so a card is never taken for one.
    fun newCard(random: java.util.Random = java.security.SecureRandom()): String =
        "EP" + (1..10).joinToString("") { random.nextInt(10).toString() }

    fun isCard(code: String): Boolean = CARD.matches(code)
    private val CARD = Regex("EP\\d{10}")

    // A card as typed or scanned: no spaces round it, an EasyPay card in capitals.
    fun cleanCard(raw: String): String {
        val t = raw.trim()
        return if (t.length == 12 && t.startsWith("ep", ignoreCase = true) && t.drop(2).all { it.isDigit() }) t.uppercase() else t
    }

    // Basis points as the percentage typed: 100 is "1", 250 is "2.5", 5 is "0.05".
    fun percent(bp: Int): String = java.math.BigDecimal(bp).movePointLeft(2).stripTrailingZeros().toPlainString()

    // A balance, said: "Rs 12.50".
    fun say(points: Long): String = Money.format(points)
}
