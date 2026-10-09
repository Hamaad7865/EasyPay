package com.restopos.core.data

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.sqrt

// The tables of a room made in the first-run set-up: what each is called and
// where it stands. The set-up asks only for a room's name, how many tables and
// how many seats at each; the plan is drawn afterwards in the back office,
// where they are moved about, renamed and given other shapes.
//
// The server holds the same bounds (0089, tables.add): a table is between 4
// and 100 wide and 4 and 60 deep, the whole of it on the 100 by 60 plan, and
// its name is its own in the whole store.
object TableLayout {
    // the most tables one room is given here, which is also the most the server takes at once
    const val MOST = 60

    class Room(val name: String, val count: Int, val seats: Int)
    class Table(val name: String, val area: String, val seats: Int, val x: Int, val y: Int, val w: Int, val h: Int)

    // The number the next table takes: one more than the highest whole number
    // among the names the store's tables have. A name is a table's own in the
    // whole store, not in its room, so the rooms are numbered on.
    fun next(names: List<String>): Int = (names.mapNotNull { it.trim().toIntOrNull() }.maxOrNull() ?: 0) + 1

    // One room on the plan, in rows, numbered from `from`. As many columns as
    // keep the cells near square; each table square, in the middle of its
    // cell, taking six tenths of the cell's shorter side and never less than
    // 4 nor more than 12.
    fun grid(room: Room, from: Int): List<Table> {
        val n = room.count
        val cols = ceil(sqrt(n * 100.0 / 60.0)).toInt().coerceAtLeast(1)
        val rows = ceil(n / cols.toDouble()).toInt().coerceAtLeast(1)
        val cw = 100.0 / cols
        val ch = 60.0 / rows
        val side = floor(minOf(cw, ch) * 0.6).toInt().coerceIn(4, 12)
        return (0 until n).map { i ->
            val x = floor((i % cols) * cw + (cw - side) / 2).toInt()
            val y = floor((i / cols) * ch + (ch - side) / 2).toInt()
            Table((from + i).toString(), room.name, room.seats, x, y, side, side)
        }
    }

    // Every room typed, numbered on from the store's last table and from one another.
    fun plan(rooms: List<Room>, names: List<String>): List<List<Table>> {
        var from = next(names)
        return rooms.map { r -> grid(r, from).also { from += r.count } }
    }

    // The lines of the form (the room's name, how many tables, the seats at
    // each), read as rooms: or why they are not rooms yet.
    // existing: the rooms the store has. One of those is not added to from
    // here: its tables stand where the back office put them.
    fun read(lines: List<Triple<String, String, String>>, existing: List<String>): Result<List<Room>> = runCatching {
        require(lines.isNotEmpty()) { "Add a room" }
        // each room's name as it was first typed, by its name in small letters
        val seen = HashMap<String, String>()
        lines.map { (name, count, seats) ->
            val called = name.trim().take(30)
            require(called.isNotEmpty()) { "Give the room a name" }
            val n = count.trim().toIntOrNull()
            require(n != null && n >= 1) { "Type how many tables" }
            require(n <= MOST) { "$MOST tables is the most for one room here. Add a second room, or lay it out in the back office." }
            val at = if (seats.isBlank()) 4 else seats.trim().toIntOrNull()
            require(at != null && at in 1..99) { "Seats are between 1 and 99" }
            val twin = seen.putIfAbsent(called.lowercase(), called)
            require(twin == null) { "Two rooms are called $twin" }
            val there = existing.firstOrNull { it.trim().equals(called, ignoreCase = true) }
            require(there == null) { "There is already a room called $there. Its tables are changed in the back office." }
            Room(called, n, at)
        }
    }
}
