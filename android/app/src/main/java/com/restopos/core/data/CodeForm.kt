package com.restopos.core.data

// The code a tablet is set up with (the server's tablet_codes, migration
// 0099): twelve letters and digits, read and typed in three groups of four.
object CodeForm {
    const val LENGTH = 12

    // What the box shows as it is typed: capitals and digits only, a dash
    // after every four, and no more than a code holds. Typed with or without
    // the dashes, in small letters, pasted with spaces: it comes out the same.
    fun typed(text: String): String =
        text.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }.take(LENGTH).chunked(4).joinToString("-")

    // A whole code is in the box.
    fun ready(text: String): Boolean = text.count { it != '-' } == LENGTH
}
