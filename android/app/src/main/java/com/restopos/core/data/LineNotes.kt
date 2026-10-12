package com.restopos.core.data

// A line's kitchen note as the order screen's keys see it: the notes ticked
// ("No onions", "Well done"), joined as the options sheet joins them, so a
// note put on from either reads the same on the kitchen ticket.
object LineNotes {
    const val JOIN = " · "

    fun split(note: String?): List<String> = note?.split(JOIN)?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()

    fun join(notes: List<String>): String? = notes.map { it.trim() }.filter { it.isNotEmpty() }.distinct().joinToString(JOIN).ifEmpty { null }

    // a tap on a note's key: on when it was off, off when it was on
    fun toggle(notes: List<String>, note: String): List<String> = if (note in notes) notes - note else notes + note
}
