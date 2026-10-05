package com.restopos.core.data

// What a refund of part of a receipt comes to. The server works this out for
// itself (push_refund_create) and refuses a refund whose amount is a cent off,
// so this is the same arithmetic, step for step, in whole cents:
//
//   1. every line of the receipt gets its share of each thing the receipt
//      charged: the subtotal (its own amount), the discount, the service
//      charge, the rounding and the tax. The lines are taken in the order of
//      the order lines' ids; each but the last takes its proportion, rounded
//      down, and the last takes what is left, so the shares add up to the
//      receipt exactly;
//   2. giving back q of a line's Q units, when d were given back before, takes
//      alloc(share, d + q) - alloc(share, d) of each share, where alloc rounds
//      to the nearest cent. Refunding unit by unit, in any order, therefore
//      returns the line's share exactly, never a cent more.
//
// Quantities are in thousandths, as everywhere on the till.
object RefundCalc {
    data class Line(val id: String, val base: Long, val qty: Int, val taxes: List<Calc.TaxRate>)
    data class Receipt(val subtotal: Long, val discount: Long, val service: Long, val rounding: Long, val taxTotal: Long, val total: Long)
    data class Share(val line: Line, val sub: Long, val disc: Long, val svc: Long, val rnd: Long, val taxAdded: Long, val taxIncluded: Long)
    // a refund's own figures: what goes on its receipt
    data class Parts(val sub: Long = 0, val disc: Long = 0, val svc: Long = 0, val rnd: Long = 0, val taxAdded: Long = 0, val taxIncluded: Long = 0) {
        val total: Long get() = sub - disc + taxAdded + svc + rnd
        val tax: Long get() = taxAdded + taxIncluded
        operator fun plus(o: Parts) = Parts(sub + o.sub, disc + o.disc, svc + o.svc, rnd + o.rnd, taxAdded + o.taxAdded, taxIncluded + o.taxIncluded)
    }

    fun alloc(share: Long, k: Int, q: Int): Long = when {
        q <= 0 -> 0
        share < 0 -> -((-share * k + q / 2) / q)
        else -> (share * k + q / 2) / q
    }

    fun shares(lines: List<Line>, rc: Receipt): List<Share> {
        val sorted = lines.sortedBy { it.id.lowercase() }
        val w = sorted.sumOf { it.base }
        val addedTotal = rc.total - (rc.subtotal - rc.discount + rc.service + rc.rounding)
        val includedTotal = rc.taxTotal - addedTotal
        var acc = Parts()
        return sorted.mapIndexed { i, l ->
            val s = if (i < sorted.size - 1) {
                val disc = if (w > 0) rc.discount * l.base / w else 0
                var added = 0L
                var included = 0L
                l.taxes.forEach { t ->
                    if (t.type == "added") added += ((l.base - disc) * t.rateBp + 5000) / 10000
                    else { val div = 10000L + t.rateBp; included += ((l.base - disc) * t.rateBp + div / 2) / div }
                }
                Share(l, l.base, disc, if (w > 0) rc.service * l.base / w else 0, if (w > 0) rc.rounding * l.base / w else 0, added, included)
            } else {
                Share(l, rc.subtotal - acc.sub, rc.discount - acc.disc, rc.service - acc.svc, rc.rounding - acc.rnd, addedTotal - acc.taxAdded, includedTotal - acc.taxIncluded)
            }
            acc += Parts(s.sub, s.disc, s.svc, s.rnd, s.taxAdded, s.taxIncluded)
            s
        }
    }

    // q of the line's units given back, when `done` were given back before
    fun parts(s: Share, done: Int, q: Int): Parts {
        fun part(x: Long) = alloc(x, done + q, s.line.qty) - alloc(x, done, s.line.qty)
        return Parts(part(s.sub), part(s.disc), part(s.svc), part(s.rnd), part(s.taxAdded), part(s.taxIncluded))
    }
}
