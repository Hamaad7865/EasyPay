package com.restopos.core.data

// The code a tablet is set up with (the server's tablet_codes, migration
// 0099): twelve letters and digits, read and typed in three groups of four.
object CodeForm {
    const val LENGTH = 12

    // The code itself: capitals and digits, whatever was typed between them.
    fun plain(text: String): String = text.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }

    // How it reads, to hold against the paper: a dash after every four.
    // Typed with or without the dashes, in small letters, pasted with
    // spaces: it reads the same. The box itself is never rewritten while it
    // is typed in: a box that changes under the keyboard loses letters.
    fun typed(text: String): String = plain(text).take(LENGTH).chunked(4).joinToString("-")

    // A whole code is in the box, and nothing more.
    fun ready(text: String): Boolean = plain(text).length == LENGTH
}
