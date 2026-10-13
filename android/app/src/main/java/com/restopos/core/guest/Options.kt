package com.restopos.core.guest

// The least and most of a group of options ("Curry spice: choose 1",
// "Add-ons: up to 3"), as rules. The order screen's options sheet taps
// through them, and an order sent from a table is held to them, so a guest's
// phone and the cashier's finger are told the same thing.
//
// What is picked of a group is how many of each option: three sausages on a
// grillade are "sausage" to 3. The least and the most count each one, so
// three sausages fill "up to 3". A most of 0 is as many as they like, which
// is what the add-on editor says of it; a most of 1 is a group where one
// thing is chosen (how it is cooked), and nothing is counted there.
object OptionRules {
    // the most of one option on one line (the server's limit too, 0105)
    const val MOST_OF_ONE = 99

    fun single(max: Int) = max == 1
    fun count(picked: Map<String, Int>) = picked.values.sum()
    // whether one more may still be picked of the group
    fun room(picked: Map<String, Int>, max: Int) = max == 0 || count(picked) < max

    // What a tap on an option leaves picked of its group. Where only one may
    // be picked, tapping another moves the pick, and tapping the one that is
    // picked clears it unless one is needed. Where several may be, a tap
    // takes one of an option or takes the option off, and a tap past the most
    // changes nothing.
    // alone: the group's choices that are picked by themselves (All among the
    // sauces, None). Picking one takes the others off, and picking another
    // takes it off; there is one of it or none.
    fun tap(picked: Map<String, Int>, option: String, min: Int, max: Int, alone: Set<String> = emptySet()): Map<String, Int> {
        val on = option in picked
        // what stays beside another choice
        val beside = picked.filterKeys { it !in alone }
        return when {
            single(max) -> if (on && min == 0) emptyMap() else mapOf(option to 1)
            on -> picked - option
            option in alone -> mapOf(option to 1)
            room(beside, max) -> beside + (option to 1)
            else -> picked
        }
    }

    // One more of an option that is picked, while the group has room for it.
    fun more(picked: Map<String, Int>, option: String, max: Int, alone: Set<String> = emptySet()): Map<String, Int> {
        val n = picked[option] ?: return picked
        return if (single(max) || option in alone || !room(picked, max) || n >= MOST_OF_ONE) picked else picked + (option to n + 1)
    }

    // One fewer of it; the last one takes the option off.
    fun fewer(picked: Map<String, Int>, option: String): Map<String, Int> {
        val n = picked[option] ?: return picked
        return if (n <= 1) picked - option else picked + (option to n - 1)
    }

    fun tooFew(min: Int, picked: Int) = picked < min
    fun tooMany(max: Int, picked: Int) = max != 0 && picked > max

    // The most a guest's phone is told. A phone takes each option once, so
    // "as many as they like" is one of each there.
    fun mostOnAPhone(max: Int, options: Int) = (if (max == 0) options else max).coerceIn(1, 20)
}
