package com.restopos.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

// A product's variants as a shop's till makes them (server 0097): up to three
// options ("Size", "Colour"), each with its values, and a line for every
// combination the product does not have yet. The tablet makes each line's id
// itself: a tablet that works on its own sells a variant before the server
// has heard of it, and the sale names the variant by that id.
object VariantForm {
    // an option as its row holds it: its name, and its values with commas between them
    data class Option(val name: String = "", val values: String = "")
    data class Line(val id: String, val values: List<String>)
    class Make(val names: List<String>, val lines: List<Line>)

    // "S, M ,  m, L" as S, M, L: what is between the commas, once each
    fun values(typed: String): List<String> {
        val seen = HashSet<String>()
        return typed.split(',', ';', '\n').map { it.trim().take(30) }.filter { it.isNotEmpty() && seen.add(it.lowercase()) }
    }

    // a line's values, from the JSON list it is kept as
    fun held(optionValues: String): List<String> =
        runCatching { Json.parseToJsonElement(optionValues).jsonArray.map { it.jsonPrimitive.content } }.getOrDefault(emptyList())

    private fun key(values: List<String>) = values.joinToString("\u001f") { it.lowercase() }

    // The options typed, read as the lines to make. has: the values of the
    // lines the product has already; hadOptions: how many options those lines
    // stand for (0 when it has none).
    fun read(options: List<Option>, has: List<List<String>>, hadOptions: Int, newId: () -> String): Result<Make> = runCatching {
        val rows = options.filter { it.name.isNotBlank() || it.values.isNotBlank() }
        require(rows.isNotEmpty()) { "Name an option, for example Size, and give its values" }
        require(rows.size <= 3) { "A product has three options at most" }
        val names = rows.map { it.name.trim().take(30) }
        require(names.none { it.isEmpty() }) { "Give each option a name" }
        require(names.map { it.lowercase() }.toSet().size == names.size) { "Two options have the same name" }
        // a product that has variants keeps its number of options
        require(has.isEmpty() || hadOptions == rows.size) { "This product's variants stand for $hadOptions " + (if (hadOptions == 1) "option" else "options") + ": that number cannot change while it has them" }
        val lists = rows.map { values(it.values) }
        rows.forEachIndexed { i, r -> require(lists[i].isNotEmpty()) { "Give " + r.name.trim() + " at least one value" } }
        // every combination, the first option's values outermost
        var combos = listOf(emptyList<String>())
        for (l in lists) combos = combos.flatMap { c -> l.map { c + it } }
        val there = has.map { key(it) }.toSet()
        val missing = combos.filter { key(it) !in there }
        require(missing.isNotEmpty()) { "Every one of those is already there" }
        require(has.size + missing.size <= 200) { "That would make more than 200 variants for one product" }
        Make(names, missing.map { Line(newId(), it) })
    }

    fun refused(code: String?): String = when (code) {
        "bad-options" -> "Those options cannot be used: an option is named twice, a value is missing, or the product already has a different number of options."
        "too-many-variants" -> "That would make more than 200 variants for one product."
        "has-stock" -> "It still holds stock. Bring that to zero first, with Remove stock."
        "unknown-item" -> "That product is no longer there."
        "unknown-variant" -> "That variant is no longer there."
        "barcode-taken" -> "Another product already has that barcode."
        "sku-taken" -> "Another product already has that SKU."
        "forbidden" -> "You are not allowed to change the products. Ask a manager."
        "conflict" -> "That did not work. Close this and try again."
        "unknown-op" -> "The server has to be updated before variants can be changed from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}
