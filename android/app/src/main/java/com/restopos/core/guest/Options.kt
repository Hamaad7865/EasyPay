package com.restopos.core.guest

// The least and most of a group of options ("Curry spice: choose 1",
// "Add-ons: up to 3"), as rules. The order screen's options sheet taps
// through them, and an order sent from a table is held to them, so a guest's
// phone and the cashier's finger are told the same thing.
object OptionRules {
    // A group that says less than one may still have one picked.
    fun most(max: Int) = max.coerceAtLeast(1)

    // What a tap on an option leaves picked of its group. Where only one may
    // be picked, tapping another moves the pick, and tapping the one that is
    // picked clears it unless one is needed. Where several may be, a tap adds
    // or takes away, and a tap past the most changes nothing.
    fun tap(picked: List<String>, option: String, min: Int, max: Int): List<String> {
        val on = option in picked
        return when {
            most(max) == 1 -> if (on && min == 0) emptyList() else listOf(option)
            on -> picked - option
            picked.size < most(max) -> picked + option
            else -> picked
        }
    }

    // Whether any of an item's groups needs a pick ("choose 1"). Such an item
    // asks first, in the options sheet; one whose groups all may be left empty
    // goes straight on the order, its options as keys under the menu.
    fun anyNeeded(mins: Iterable<Int>) = mins.any { it >= 1 }

    fun tooFew(min: Int, picked: Int) = picked < min
    fun tooMany(max: Int, picked: Int) = picked > most(max)
}
