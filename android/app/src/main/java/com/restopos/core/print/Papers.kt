package com.restopos.core.print

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

// How the receipt and the kitchen ticket are laid out: a column of blocks,
// made in the back office's Receipt design and kept in the settings under
// `papers` (docs/superpowers/specs/2026-10-15-receipt-designer-design.md).
// With none, each prints EasyPay's design, which is the paper as it always
// was. The back office's preview reads and prints the same way
// (web/lib/papers.ts); the shared examples in db/tests/fixtures/papers hold
// the two together.

// One block. A kind's own defaults are EasyPay's settings for it; a design
// keeps only what differs. size: normal, tall or big; align: left, center
// or right; above: a line over it when it prints anything.
data class Block(
    val k: String,
    val hide: Boolean = false,
    val size: String = "normal",
    val bold: Boolean = false,
    val align: String = "left",
    val above: Boolean = false,
    val text: String = "", // Text
    val ch: Char = '-', // Line: - or =
    val n: Int = 1, // Space: blank lines, 1 to 5
    // Items: add-ons on one line or in rows (the kitchen: a line per group or
    // all on one line), with their prices, the price of one, the notes, the
    // old price, the seat
    val addons: String = "line",
    val addonPrices: Boolean = false,
    val unitPrice: Boolean = false,
    val notes: Boolean = true,
    val was: Boolean = true,
    val seat: Boolean = true,
)

data class Design(val blocks: List<Block>)

object Papers {
    const val VERSION = 1
    const val MOST = 60 // blocks to a paper
    const val TEXT = 300 // letters in a Text block

    // the kinds that can be on a paper more than once, and the only ones a design can remove
    val REPEATABLE = setOf("text", "line", "space")

    private fun kinds(vararg b: Block): Map<String, Block> = b.associateBy { it.k }

    // The receipt's kinds, with EasyPay's settings for each.
    val RECEIPT_KINDS: Map<String, Block> = kinds(
        Block("logo", align = "center"),
        Block("name", align = "center", size = "big"),
        Block("address", align = "center"),
        Block("phone", align = "center"),
        Block("brn", align = "center"),
        Block("vat", align = "center"),
        Block("header", align = "center"),
        Block("title", align = "center", bold = true),
        Block("customer_no", align = "center", bold = true, size = "big"),
        Block("receipt_no"), Block("date_order"), Block("order_type"), Block("served_by"),
        Block("guests"), Block("customer"), Block("refund_of"),
        Block("items"),
        Block("subtotal"), Block("discounts"), Block("service"), Block("taxes"), Block("rounding"),
        Block("total", bold = true, size = "tall"),
        Block("share", bold = true, above = true),
        Block("payments"),
        Block("bill_note", align = "center", above = true),
        Block("remark", above = true),
        Block("footer", align = "center", above = true),
        Block("barcode"),
        Block("text"), Block("line"), Block("space"),
    )

    val KITCHEN_KINDS: Map<String, Block> = kinds(
        Block("station", align = "center", bold = true),
        Block("heading", align = "center", bold = true, size = "big"),
        Block("pickup", align = "center", bold = true, size = "tall"),
        Block("time_waiter"),
        Block("type_guests"),
        Block("items", bold = true, size = "tall", addons = "groups"),
        Block("remark", bold = true, above = true),
        Block("text"), Block("line", ch = '='), Block("space"),
    )

    // Always printed: moved and set, never hidden. A shop's barcode too: its returns are scanned from it.
    val LOCKED_RECEIPT = setOf("title", "items", "total")
    val LOCKED_KITCHEN = setOf("items")

    private fun of(kinds: Map<String, Block>, vararg k: String) = Design(k.map { kinds.getValue(it) })

    // EasyPay's designs: the papers as they were before there was a designer.
    val RECEIPT: Design = of(
        RECEIPT_KINDS,
        "logo", "name", "address", "phone", "brn", "vat", "header", "line",
        "title", "customer_no", "receipt_no", "date_order", "order_type", "served_by", "guests", "customer", "refund_of", "line",
        "items", "line",
        "subtotal", "discounts", "service", "taxes", "rounding", "total", "share", "payments",
        "bill_note", "remark", "footer", "barcode",
    )
    val KITCHEN: Design = of(KITCHEN_KINDS, "station", "heading", "pickup", "time_waiter", "type_guests", "line", "items", "remark", "line")

    private val SIZES = setOf("normal", "tall", "big")
    private val ALIGNS = setOf("left", "center", "right")
    private val json = Json { ignoreUnknownKeys = true }

    // The receipt's design from the settings' `papers` (as text), or EasyPay's.
    fun receipt(papers: String?, shop: Boolean): Design =
        read(entry(papers, "receipt"), RECEIPT_KINDS, LOCKED_RECEIPT + (if (shop) setOf("barcode") else emptySet()), setOf("line", "rows")) ?: RECEIPT

    fun kitchen(papers: String?): Design = read(entry(papers, "kitchen"), KITCHEN_KINDS, LOCKED_KITCHEN, setOf("groups", "line")) ?: KITCHEN

    private fun entry(papers: String?, paper: String): JsonElement? =
        if (papers.isNullOrBlank()) null else runCatching { (json.parseToJsonElement(papers) as? JsonObject)?.get(paper) }.getOrNull()

    private fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    private fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

    // A paper read forgivingly: null (print EasyPay's) when it is not one, is
    // of another version, or lacks a locked block or hides one. A block of a
    // kind not known here is skipped, so a later back office cannot stop this
    // till printing; so is a second block of a kind that is there once. A
    // setting not understood takes the kind's own.
    fun read(el: JsonElement?, kinds: Map<String, Block>, locked: Set<String>, addons: Set<String>): Design? {
        val o = el as? JsonObject ?: return null
        if (o.int("v") != VERSION) return null
        val rows = o["blocks"] as? JsonArray ?: return null
        val seen = HashSet<String>()
        val out = ArrayList<Block>()
        for (r in rows) {
            val b = r as? JsonObject ?: continue
            val k = b.str("k") ?: continue
            val base = kinds[k] ?: continue
            if (k !in REPEATABLE && !seen.add(k)) continue
            out += Block(
                k = k,
                hide = b.bool("hide") ?: base.hide,
                size = b.str("size")?.takeIf { it in SIZES } ?: base.size,
                bold = b.bool("bold") ?: base.bold,
                align = b.str("align")?.takeIf { it in ALIGNS } ?: base.align,
                above = b.bool("above") ?: base.above,
                text = (b.str("text") ?: base.text).replace("\r", "").take(TEXT),
                ch = b.str("ch")?.takeIf { it == "-" || it == "=" }?.first() ?: base.ch,
                n = b.int("n")?.takeIf { it in 1..5 } ?: base.n,
                addons = b.str("addons")?.takeIf { it in addons } ?: base.addons,
                addonPrices = b.bool("addonPrices") ?: base.addonPrices,
                unitPrice = b.bool("unitPrice") ?: base.unitPrice,
                notes = b.bool("notes") ?: base.notes,
                was = b.bool("was") ?: base.was,
                seat = b.bool("seat") ?: base.seat,
            )
            if (out.size == MOST) break
        }
        if (locked.any { k -> out.none { it.k == k && !it.hide } }) return null
        return Design(out)
    }
}
