package com.restopos.core.data

import com.restopos.core.common.Money

// A group of add-ons as a till's own sheet makes or changes it (server
// 0096): its name ("Extras", "Cooking"), the fewest and the most of its
// choices that may be picked, and the choices with their prices. The fewest
// 0 makes it optional and 1 means one must be picked; the most 0 is as many
// as they like. The group is saved whole.
object AddonForm {
    data class Choice(val id: String, val name: String, val price: Long)
    data class Group(val name: String, val min: Int, val max: Int, val choices: List<Choice>)
    // a choice as its row holds it; id: made when the row was added, or the choice's own
    data class Typed(val id: String, val name: String = "", val price: String = "")

    fun read(name: String, min: String, max: String, rows: List<Typed>): Result<Group> = runCatching {
        val called = name.trim().take(40)
        require(called.isNotEmpty()) { "Give the group a name, for example Extras or Cooking" }
        val least = if (min.isBlank()) 0 else min.trim().toIntOrNull() ?: throw IllegalArgumentException("The fewest is a number from 0 to 20")
        val most = if (max.isBlank()) 0 else max.trim().toIntOrNull() ?: throw IllegalArgumentException("The most is a number from 0 to 20")
        require(least in 0..20 && most in 0..20) { "The fewest and the most are numbers from 0 to 20" }
        require(most == 0 || most >= least) { "The most that can be picked cannot be less than the fewest" }
        // a row left empty is not a choice
        val choices = rows.filter { it.name.isNotBlank() || it.price.isNotBlank() }.map { r ->
            val n = r.name.trim().take(40)
            require(n.isNotEmpty()) { "Give each choice a name" }
            val price = if (r.price.isBlank()) 0L else Money.parseRs(r.price) ?: throw IllegalArgumentException("The price of $n is not a number")
            require(price <= LinePrice.MOST) { "The price of $n is too large" }
            Choice(r.id, n, price)
        }
        require(choices.size <= 50) { "A group holds 50 choices at most" }
        require(choices.map { it.name.lowercase() }.toSet().size == choices.size) { "Two choices have the same name" }
        Group(called, least, most, choices)
    }

    // "Optional · any number", "Pick 1", "Pick 1 to 3"
    fun rule(min: Int, max: Int): String = when {
        min == 0 && max == 0 -> "Optional, any number"
        min == 0 -> "Optional, up to $max"
        max == 0 -> "At least $min"
        min == max -> "Pick $min"
        else -> "Pick $min to $max"
    }

    fun refused(code: String?): String = when (code) {
        "name-required" -> "Give the group, and each choice, a name"
        "name-taken" -> "Another group already has that name."
        "bad-limits" -> "The most that can be picked cannot be less than the fewest, and neither is more than 20."
        "too-many" -> "A group holds 50 choices at most."
        "bad-group" -> "That group is no longer there."
        "forbidden" -> "You are not allowed to change the add-ons. Ask a manager."
        "conflict" -> "That did not work. Close this and try again."
        "unknown-op" -> "The server has to be updated before add-ons can be changed from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}
