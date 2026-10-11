package com.restopos.core.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// A room's plan while it is being changed on the tablet (feature/floor's
// editor): its tables as they stand on the screen, before Save.
//
// A restaurant that works on its own has no back office, so what the back
// office's floor plan page does (web/app/backoffice/tables/floor-editor.tsx)
// is done here by the same rules: a plan of 100 by 60, a table dragged to its
// place and by its corner to its size, a number, covers and a shape for each,
// several added at once and numbered on from the first. Nothing is saved
// until Save, which sends the whole room as one change (server 0101,
// floor.save): a drag is not a change.
object FloorPlan {
    const val W = 100
    const val H = 60
    // the least a table is drawn down to here, as in the back office's editor (the server takes 4)
    const val MIN = 6
    // what a table added here starts at
    const val NEW = 12
    // the most tables a store holds
    const val MOST = 300

    data class Table(val id: String, val name: String, val seats: Int, val shape: String, val x: Int, val y: Int, val w: Int, val h: Int)

    // Put at (x, y), as near to it as keeps the whole table on the plan.
    fun moved(t: Table, x: Int, y: Int): Table = t.copy(x = x.coerceIn(0, W - t.w), y = y.coerceIn(0, H - t.h))

    // Made w by h, as near to it as the plan and the least size allow. A table
    // the back office left smaller than the least here is not made bigger by
    // being touched: it can only grow from what it is.
    fun sized(t: Table, w: Int, h: Int): Table = t.copy(
        w = w.coerceIn(minOf(MIN, t.w, W - t.x), W - t.x),
        h = h.coerceIn(minOf(MIN, t.h, H - t.y), H - t.y),
    )

    // The first free spot on the plan for a table of w by h, scanning left to
    // right and then down; the corner when the plan is full.
    fun freeSpot(placed: List<Table>, w: Int, h: Int): Pair<Int, Int> {
        var y = 2
        while (y + h <= H) {
            var x = 2
            while (x + w <= W) {
                if (placed.none { x < it.x + it.w && it.x < x + w && y < it.y + it.h && it.y < y + h }) return x to y
                x += w + 3
            }
            y += h + 3
        }
        return 2 to 2
    }

    // The lowest whole number no table is called yet. taken: every name of the store, in small letters.
    fun nextNumber(taken: Set<String>): String {
        var n = 1
        while (n.toString() in taken) n++
        return n.toString()
    }

    // "Add table": `count` tables of `seats` covers, named from `first`
    // upwards ("7" gives 7, 8, 9; "T7" gives T7, T8, T9), skipping names
    // already used anywhere in the store, each on the first free spot.
    // room: the tables on the plan now. taken: every name of the store, in
    // small letters, this room's among them.
    fun add(room: List<Table>, taken: Set<String>, count: Int, seats: Int, shape: String, first: String, newId: () -> String): List<Table> {
        val used = HashSet(taken)
        val m = Regex("^(.*?)(\\d+)$").find(first.trim())
        val prefix = m?.groupValues?.get(1) ?: first.trim().let { if (it.isEmpty()) "" else "$it " }
        var n = m?.groupValues?.get(2)?.toIntOrNull() ?: 1
        val placed = ArrayList(room)
        val made = ArrayList<Table>()
        repeat(count.coerceIn(1, 50)) {
            while ((prefix + n).lowercase() in used) n++
            val name = (prefix + n).take(30)
            used += name.lowercase()
            val (x, y) = freeSpot(placed, NEW, NEW)
            val t = Table(newId(), name, seats.coerceIn(1, 99), if (shape == "round") "round" else "square", x, y, NEW, NEW)
            placed += t
            made += t
        }
        return made
    }

    // Why the room cannot be saved as it stands, in words; null when it can.
    // elsewhere: the names of the store's tables in other rooms, in small
    // letters. others: how many tables the other rooms hold.
    fun problem(room: List<Table>, elsewhere: Set<String>, others: Int): String? {
        val seen = HashSet<String>()
        for (t in room) {
            val name = t.name.trim()
            if (name.isEmpty()) return "Every table needs a number."
            if (!seen.add(name.lowercase())) return "Two tables are called \"$name\". Give each its own number."
            if (name.lowercase() in elsewhere) return "Table \"$name\" is in another room already. Give this one another number."
        }
        if (others + room.size > MOST) return "A store holds $MOST tables at most."
        return null
    }

    // ---- what is sent (server 0101); each is held against an example in db/tests/fixtures/till-floor ----

    fun save(store: String, area: String, tables: List<Table>, removed: List<String>, approvedBy: String?): JsonObject = buildJsonObject {
        put("store_id", store); put("area", area)
        putJsonArray("tables") {
            tables.forEach { t ->
                addJsonObject {
                    put("id", t.id); put("name", t.name.trim()); put("seats", t.seats); put("shape", t.shape)
                    put("x", t.x); put("y", t.y); put("w", t.w); put("h", t.h)
                }
            }
        }
        putJsonArray("removed") { removed.forEach { add(it) } }
        approvedBy?.let { put("approved_by", it) }
    }

    fun rename(store: String, from: String, to: String, approvedBy: String?): JsonObject = buildJsonObject {
        put("store_id", store); put("from", from); put("to", to.trim())
        approvedBy?.let { put("approved_by", it) }
    }

    fun remove(store: String, area: String, approvedBy: String?): JsonObject = buildJsonObject {
        put("store_id", store); put("area", area)
        approvedBy?.let { put("approved_by", it) }
    }
}
