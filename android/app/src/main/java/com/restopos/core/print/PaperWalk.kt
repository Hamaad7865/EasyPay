package com.restopos.core.print

// What each block of a design puts on the paper, and how it is printed.
// web/lib/papers.ts does the same for the back office's preview: a change
// here is a change there, and the shared examples (PapersFixtureTest,
// web/lib/papers.test.mjs) fail until both agree.

// A line's style: size (normal, tall, big), bold, and where it is set.
internal data class St(val size: String, val bold: Boolean, val align: String)

// What a block prints, each piece in the block's own style unless it names
// one. Words wrap at the paper's width (half of it when big), behind an
// indent; a Line is printed as it comes (wrapped only when big); a Row is
// words on the left and a figure on the right, across the paper.
internal sealed class Out {
    data class Words(val s: String, val indent: String = "", val st: St? = null) : Out()
    data class Line(val s: String, val st: St? = null) : Out()
    data class Row(val left: String, val right: String, val st: St? = null, val indent: String = "") : Out()
    data class Rule(val ch: Char) : Out()
    object Blank : Out()
    data class Bars(val code: String) : Out()
    class Picture(val r: Raster) : Out()
}

internal object PaperWalk {
    private val PLAIN = St("normal", false, "left")
    private val VAR = Regex("\\{([a-z_]+)\\}")

    // A block's pieces onto the paper: nothing at all when it has nothing to
    // say, not even the line above it.
    fun print(p: EscPos, b: Block, outs: List<Out>) {
        if (outs.isEmpty()) return
        if (b.above) { set(p, PLAIN); p.rule('-') }
        val own = St(b.size, b.bold, b.align)
        for (o in outs) when (o) {
            is Out.Words -> {
                val s = o.st ?: own
                set(p, s)
                EscPos.wrap(o.s, width(p, s) - o.indent.length).forEach { p.line(o.indent + it) }
            }
            is Out.Line -> {
                val s = o.st ?: own
                set(p, s)
                if (s.size == "big") EscPos.wrap(o.s, width(p, s)).forEach { p.line(it) } else p.line(o.s)
            }
            is Out.Row -> {
                val s = (o.st ?: own).copy(align = "left")
                set(p, s)
                val w = width(p, s)
                // Big, 16 characters on 58 mm: when the words and the figure cannot share
                // a line, the figure goes under them at the right, not "TOTA" over "L"
                if (s.size == "big" && o.indent.length + o.left.trim().length + 1 + o.right.length > w) {
                    p.row(o.left, "", w, o.indent)
                    p.row("", o.right, w)
                } else p.row(o.left, o.right, w, o.indent)
            }
            is Out.Rule -> { set(p, PLAIN); p.rule(o.ch) }
            Out.Blank -> { set(p, PLAIN); p.line() }
            is Out.Bars -> { set(p, PLAIN); p.barcode(o.code) }
            is Out.Picture -> { set(p, own.copy(size = "normal", bold = false)); p.raster(o.r.widthBytes, o.r.height, o.r.bits) }
        }
        set(p, PLAIN)
    }

    private fun set(p: EscPos, s: St) {
        p.align(when (s.align) { "center" -> EscPos.Align.Center; "right" -> EscPos.Align.Right; else -> EscPos.Align.Left })
        p.bold(s.bold)
        when (s.size) { "big" -> p.big(true); "tall" -> p.tall(true); else -> p.big(false) }
    }

    private fun width(p: EscPos, s: St) = if (s.size == "big") p.columns / 2 else p.columns

    // {customer_no} and the rest: one the paper has nothing for is left empty;
    // a word in braces that is not one is printed as it was typed
    fun fill(text: String, vars: Map<String, String?>): String =
        VAR.replace(text) { m -> if (m.groupValues[1] in vars) vars[m.groupValues[1]].orEmpty() else m.value }

    private fun text(b: Block, vars: Map<String, String?>): List<Out> =
        fill(b.text, vars).takeIf { it.isNotBlank() }?.let { listOf(Out.Words(it)) } ?: emptyList()

    private fun words(s: String): List<Out> = if (s.isNotBlank()) listOf(Out.Words(s)) else emptyList()

    // "3 x Egg", as the receipt has always said it
    fun addonName(a: DocAddon): String = if (a.qty > 1) "${a.qty} x ${a.name}" else a.name

    fun receiptVars(d: ReceiptDoc, shop: Shop, decimals: Int): Map<String, String?> = mapOf(
        "business" to shop.name, "customer_no" to d.customerNo, "order" to d.order, "receipt_no" to d.number,
        "date" to Docs.stamp(d.time).substringBefore(' '), "time" to Docs.stamp(d.time).substringAfter(' '),
        "cashier" to d.cashier, "waiter" to d.waiter, "guests" to d.covers?.toString(), "order_type" to d.dining,
        "customer" to d.customer, "total" to "Rs " + Docs.num(d.total, decimals),
    )

    fun kitchenVars(d: KitchenDoc): Map<String, String?> = mapOf(
        "customer_no" to d.customerNo, "order" to d.order,
        "date" to Docs.stamp(d.time).substringBefore(' '), "time" to Docs.stamp(d.time).substringAfter(' '),
        "waiter" to d.waiter, "guests" to d.covers?.toString(), "order_type" to d.dining, "station" to d.station, "pickup" to d.pickup,
    )

    private fun fiscal(f: Fiscal?): List<Out> = when (f) {
        null -> emptyList()
        is Fiscal.Qr -> listOfNotNull(Out.Picture(f.r), if (f.training) Out.Line("TRAINING") else null)
        is Fiscal.NotYet -> listOfNotNull(Out.Line("Not Yet Fiscalised"), if (f.training) Out.Line("TRAINING") else null)
    }

    // The receipt's blocks (with the bill, a refund and a guest's share).
    fun receipt(b: Block, d: ReceiptDoc, shop: Shop, decimals: Int, logo: Raster?): List<Out> {
        val n = { c: Long -> Docs.num(c, decimals) }
        return when (b.k) {
            "logo" -> listOfNotNull(logo?.let { Out.Picture(it) })
            "name" -> words(shop.name)
            "address" -> words(shop.address)
            "phone" -> if (shop.phone.isNotBlank()) listOf(Out.Line("Tel: ${shop.phone}")) else emptyList()
            "brn" -> if (shop.brn.isNotBlank()) listOf(Out.Line("BRN: ${shop.brn}")) else emptyList()
            "vat" -> if (shop.vat.isNotBlank()) listOf(Out.Line("VAT: ${shop.vat}")) else emptyList()
            "header" -> words(shop.header)
            // the MRA's QR code, or the words in its place, at the top of what the customer gets
            "title" -> fiscal(d.fiscal) + listOfNotNull(
                Out.Line(when (d.kind) { "bill" -> "BILL"; "refund" -> "REFUND"; else -> "RECEIPT" }),
                if (d.reprint) Out.Line("COPY") else null,
                if (d.refunded > 0) Out.Line(if (d.refundedAll) "*** REFUNDED ***" else "*** PARTLY REFUNDED: ${n(d.refunded)} ***") else null,
            )
            // the number the customer is called by
            "customer_no" -> listOfNotNull(d.customerNo?.let { Out.Words("CUSTOMER No. $it") })
            "receipt_no" -> if (d.number.isNotBlank()) listOf(Out.Row("No.", d.number)) else emptyList()
            "date_order" -> listOf(Out.Row(Docs.stamp(d.time), d.order))
            "order_type" -> listOfNotNull(d.dining?.let { Out.Row("Order type", it) })
            "served_by" -> listOfNotNull(
                (d.cashier ?: d.waiter)?.let { Out.Row("Served by", it) },
                if (d.waiter != null && d.cashier != null && d.waiter != d.cashier) Out.Row("Waiter", d.waiter) else null,
            )
            "guests" -> listOfNotNull(d.covers?.let { Out.Row("Guests", it.toString()) })
            "customer" -> listOfNotNull(d.customer?.takeIf { it.isNotBlank() && it != d.order }?.let { Out.Row("Customer", it) })
            "refund_of" -> listOfNotNull(d.refundOf?.let { Out.Row("Refund of", it) }, d.reason?.takeIf { it.isNotBlank() }?.let { Out.Words("Reason: $it") })
            "items" -> d.lines.flatMap { item(b, it, n) }
            "subtotal" -> if (d.discounts.isNotEmpty() || d.rounding != 0L || d.service != 0L) listOf(Out.Row("Subtotal", n(d.subtotal))) else emptyList()
            "discounts" -> d.discounts.map { Out.Row("Discount: ${it.name}", "-" + n(it.amount)) }
            "service" -> if (d.service != 0L) listOf(Out.Row("Service charge", n(d.service))) else emptyList()
            "taxes" -> d.taxes.map { t ->
                val rate = if (t.rateBp % 100 == 0) "${t.rateBp / 100}" else "%.2f".format(java.util.Locale.US, t.rateBp / 100.0)
                Out.Row("${t.name} $rate%" + if (t.included) " (incl.)" else "", n(t.amount))
            }
            "rounding" -> if (d.rounding != 0L) listOf(Out.Row("Rounding", n(d.rounding))) else emptyList()
            "total" -> listOf(Out.Row(if (d.kind == "refund") "REFUNDED" else "TOTAL", "Rs " + n(d.total)))
            // one guest's copy: the whole bill above, then what this guest paid and the tax in it
            "share" -> if (d.share != null && d.shares != null) {
                val mine = d.payments.sumOf { it.amount }
                val tax = d.taxes.sumOf { it.amount }
                listOfNotNull(
                    Out.Row("SHARE ${d.share} OF ${d.shares}", "Rs " + n(mine)),
                    if (tax > 0 && d.total > 0) Out.Row("Tax in this share", n((tax * mine + d.total / 2) / d.total), PLAIN) else null,
                )
            } else emptyList()
            "payments" -> d.payments.flatMap { pay ->
                listOfNotNull(
                    Out.Row(pay.name, n(pay.amount)),
                    pay.reference?.takeIf { it.isNotBlank() }?.let { Out.Line("  Ref: $it") },
                ) + if (pay.tendered != null && pay.change > 0) listOf(Out.Row("  Given", n(pay.tendered)), Out.Row("  Change", n(pay.change))) else emptyList()
            } + listOfNotNull(
                d.owed?.let { Out.Row("Balance owed on account", n(it)) },
                // loyalty points (0128)
                d.pointsEarned?.takeIf { it > 0 }?.let { Out.Row("Points earned", n(it)) },
                d.pointsTaken?.takeIf { it > 0 }?.let { Out.Row("Points taken back", n(it)) },
                d.pointsBack?.takeIf { it > 0 }?.let { Out.Row("Points given back", n(it)) },
                d.pointsBalance?.let { Out.Row("Points balance", (if (it < 0) "-" else "") + n(Math.abs(it))) },
            )
            "bill_note" -> if (d.kind == "bill") listOf(Out.Words("This is not a receipt")) else emptyList()
            "remark" -> listOfNotNull(d.note?.takeIf { it.isNotBlank() }?.let { Out.Words("Remark: $it") })
            "footer" -> words(shop.footer)
            // Its number in bars: scanned at a till, it opens this receipt, for
            // another copy, a refund or an exchange. A bill has no number yet.
            "barcode" -> if (shop.bars && d.kind != "bill" && d.number.isNotBlank()) listOf(Out.Blank, Out.Bars(d.number)) else emptyList()
            "text" -> text(b, receiptVars(d, shop, decimals))
            "line" -> listOf(Out.Rule(b.ch))
            "space" -> List(b.n) { Out.Blank }
            else -> emptyList()
        }
    }

    // One line of the receipt: the item, the price of one, the old price,
    // the add-ons, the note. With prices, the item says its own price and
    // each add-on what it adds; a receipt kept from before has no add-on
    // prices and says the line's total with the names, whatever the design.
    private fun item(b: Block, l: DocLine, n: (Long) -> String): List<Out> {
        val priced = b.addonPrices && l.addons.isNotEmpty()
        val adds = if (priced) l.addons.sumOf { it.price } else 0L
        val out = ArrayList<Out>()
        out += Out.Row("${Docs.qty(l.qty)} ${l.name}", n(l.amount - adds))
        if (b.unitPrice && l.unit != null && l.qty != 1000) out += Out.Words("${Docs.qty(l.qty)} x ${n(l.unit)}", "  ", PLAIN)
        // the price it was listed at, and what was done to it
        if (b.was && l.was != null && l.was != l.amount) out += Out.Words(listOfNotNull("was ${n(l.was - adds)}", l.priceNote?.takeIf { it.isNotBlank() }).joinToString(", "), "  ", PLAIN)
        if (priced) {
            if (b.addons == "rows") l.addons.forEach { a ->
                out += if (a.price != 0L) Out.Row("+ ${addonName(a)}", n(a.price), PLAIN, "  ") else Out.Words("+ ${addonName(a)}", "  ", PLAIN)
            } else out += Out.Words("+ " + l.addons.joinToString(", ") { a -> addonName(a) + if (a.price != 0L) " ${n(a.price)}" else "" }, "  ", PLAIN)
        } else {
            // all of a line's add-ons on one line, wrapped under the + when too long (the owner, 2026-10-15)
            val names = l.mods.ifEmpty { l.addons.map { addonName(it) } }
            if (names.isNotEmpty()) {
                if (b.addons == "rows") names.forEach { out += Out.Words("+ $it", "  ", PLAIN) }
                else out += Out.Words("+ " + names.joinToString(", "), "  ", PLAIN)
            }
        }
        if (b.notes) l.note?.takeIf { it.isNotBlank() }?.let { out += Out.Words("* $it", "  ", PLAIN) }
        return out
    }

    // The kitchen ticket's blocks: what the kitchen or the bar has to make, big, with no prices.
    fun kitchen(b: Block, d: KitchenDoc): List<Out> = when (b.k) {
        "station" -> listOf(Out.Line(if (d.title == "ORDER") d.station.uppercase() else "${d.title} - ${d.station.uppercase()}"))
        // the customer's number large, then who it is for; or the table, or the order's name, large
        "heading" -> if (d.customerNo != null) {
            listOfNotNull(Out.Line("No. ${d.customerNo}"), d.order.takeIf { it.isNotBlank() }?.let { Out.Words(it, st = St("normal", b.bold, b.align)) })
        } else words(d.order)
        // when a takeaway is picked up, under who it is for
        "pickup" -> listOfNotNull(d.pickup?.let { Out.Line(it) })
        "time_waiter" -> listOf(Out.Row(Docs.stamp(d.time), d.waiter ?: ""))
        "type_guests" -> listOfNotNull(d.dining, d.covers?.let { "$it guests" }).joinToString(" · ").let { if (it.isNotBlank()) listOf(Out.Line(it.replace("·", "-"))) else emptyList() }
        "items" -> {
            var course: Int? = null
            // an order that is all course 1 needs no course heading
            val courses = d.lines.any { (it.course ?: 1) > 1 }
            d.lines.flatMap { l ->
                val out = ArrayList<Out>()
                if (courses && l.course != null && l.course != course) {
                    course = l.course
                    out += Out.Line("--- Course ${l.course} ---", St("normal", false, "center"))
                }
                out += Out.Words("${Docs.qty(l.qty)} x ${l.name}")
                if (b.seat) l.seat?.let { out += Out.Line("   Seat $it", PLAIN) }
                // a line for each add-on group, its choices side by side (DocBuilder.kitchen); or all on one line
                if (b.addons == "line") { if (l.mods.isNotEmpty()) out += Out.Words("* " + l.mods.joinToString(", "), "   ", PLAIN) }
                else l.mods.forEach { m -> out += Out.Words("* $m", "   ", PLAIN) }
                if (b.notes) l.note?.takeIf { it.isNotBlank() }?.let { out += Out.Words("! $it", "   ", St("normal", true, "left")) }
                out
            }
        }
        "remark" -> listOfNotNull(d.note?.takeIf { it.isNotBlank() }?.let { Out.Words("REMARK: $it") })
        "text" -> text(b, kitchenVars(d))
        "line" -> listOf(Out.Rule(b.ch))
        "space" -> List(b.n) { Out.Blank }
        else -> emptyList()
    }
}
