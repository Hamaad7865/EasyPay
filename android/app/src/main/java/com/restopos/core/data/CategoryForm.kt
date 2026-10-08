package com.restopos.core.data

// A category as the till's own sheet makes or changes it: its name and its
// colour. Its printers, its place among the buttons and whether its stock is
// counted are the back office's. The server checks all of it again and has
// the last word.
object CategoryForm {
    class Category(val name: String, val color: String?)

    // The colours a category can be given on the till. The first eight are
    // also what a category with no colour is painted in, by its place.
    val SWATCHES = listOf(
        "#B9521C", "#2459C9", "#B83A3A", "#8F6A0E", "#A8366F", "#117785", "#6243C8", "#74513A",
        "#2F7D4F", "#C2410C", "#475569", "#0E7490",
    )
    private val HEX = Regex("#[0-9A-Fa-f]{6}")

    // What the sheet holds, read as a category, or why it is not one yet.
    fun read(name: String, color: String?): Result<Category> = runCatching {
        val called = name.trim().take(60)
        require(called.isNotEmpty()) { "Give it a name" }
        val paint = color?.trim().orEmpty()
        require(paint.isEmpty() || HEX.matches(paint)) { "Pick one of the colours" }
        // lower case, as the back office's picker writes it
        Category(called, paint.lowercase().ifEmpty { null })
    }

    // The swatches a sheet shows: a colour chosen in the back office that is
    // not among them stands last, so it can be seen and kept.
    fun shown(color: String?): List<String> =
        if (color != null && HEX.matches(color) && SWATCHES.none { same(it, color) }) SWATCHES + color else SWATCHES

    fun same(a: String?, b: String?): Boolean = a.orEmpty().trim().equals(b.orEmpty().trim(), ignoreCase = true)

    // The server's refusal of category.save or category.remove (migration 0087), in words.
    fun refused(code: String?): String = when (code) {
        "name-required" -> "Give it a name"
        "bad-category" -> "That category is no longer there."
        "has-items" -> "This category still has items in it. Move or remove them first."
        "conflict" -> "That did not work. Close this and try again."
        "forbidden" -> "You are not allowed to change the categories. Ask a manager."
        "bad-payload" -> "Pick one of the colours and try again."
        "unknown-op" -> "The server has to be updated before categories can be changed from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}
