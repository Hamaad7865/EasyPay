package com.restopos.feature.pay

// How the pay screen fits a tablet that is not tall.
//
// The owner, trying a physical tablet: "on the pay screen, the change amount
// component was being squished". Beside the keypad there is a column:
// Tendered, four quick amounts, Change. It was laid out at its full size
// whatever room there was, so on a screen lower than the emulator's the last
// thing in it, the change to give, got what was left.
//
// What gives way now, in this order, so that Tendered and Change are always
// whole:
//   1. on a side that is not tall, the amount at the top goes on one line and
//      the payment types and the Charge key are a little lower, which leaves
//      the keypad's row more room;
//   2. the quick amounts take what is left between Tendered and Change: two
//      rows, one row, or none, and are never drawn squeezed;
//   3. on a very low keypad row, Tendered and Change are drawn a size smaller.
// All in dp, so it is the same on every screen density.
internal object PayFit {
    // the usual height of a quick amount's key, the least it is drawn at, and the gap between two rows
    const val KEY = 54f
    const val KEY_MIN = 40f
    const val GAP = 8f

    // The side with the amount, the payment types, the keypad and Charge: is it short of the room its usual sizes take?
    fun short(sideDp: Float): Boolean = sideDp < 640f

    // The keypad's row: is it so low that Tendered and Change are drawn a size smaller?
    fun tight(rowDp: Float): Boolean = rowDp < 230f

    // How many rows of quick amounts fit in the room between Tendered and Change.
    fun quickRows(roomDp: Float): Int = when {
        roomDp >= 2 * KEY_MIN + GAP -> 2
        roomDp >= KEY_MIN -> 1
        else -> 0
    }

    // How tall each of their keys is then: what the room allows, and never more than usual.
    fun quickKey(roomDp: Float, rows: Int): Float = if (rows <= 0) 0f else minOf(KEY, (roomDp - GAP * (rows - 1)) / rows)
}
