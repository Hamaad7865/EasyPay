package com.restopos.core.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// A room's plan while it is being changed on the tablet (feature/floor's
// editor): its tables and what stands in it as they are on the screen, before
// Save.
//
// A restaurant that works on its own has no back office, so what the back
// office's floor plan page does (web/app/backoffice/tables/designer.tsx) is
// done here by the same rules: a plan of 100 by 60, a table dragged to its
// place and by its corner to its size, a number, covers and a shape for each,
// several added at once and numbered on from the first. Nothing is saved
// until Save, which sends the whole room as one change (server 0101,
// floor.save): a drag is not a change.
//
// Since server 0102 a table may be set at an angle, a booth and a bar stool
// are tables, and a room has elements: walls, doors, windows, a bar. The one
// rule for an angle, here as on the server: a piece's place and size are its
// rectangle before it is turned, and that rectangle is what stays whole on
// the plan. The angle turns the drawing about the rectangle's middle.
object FloorPlan {
    const val W = 100
    const val H = 60
    // the least a table is drawn down to here, as in the back office's editor (the server takes 4)
    const val MIN = 6
    // what a table added here starts at
    const val NEW = 12
    // the most tables a store holds, and the most elements
    const val MOST = 300
    const val MOST_ELEMENTS = 200
    // a piece is turned by this many degrees a tap
    const val TURN = 15

    val SHAPES = listOf("square", "round", "booth", "stool")
    val KINDS = listOf("wall", "door", "window", "bar")

    data class Table(val id: String, val name: String, val seats: Int, val shape: String, val x: Int, val y: Int, val w: Int, val h: Int, val rotation: Int = 0)

    // What stands in the room beside the tables. It has no number and no seats.
    data class Element(val id: String, val kind: String, val x: Int, val y: Int, val w: Int, val h: Int, val rotation: Int = 0)

    // Put at (x, y), as near to it as keeps the whole table on the plan.
    fun moved(t: Table, x: Int, y: Int): Table = t.copy(x = x.coerceIn(0, W - t.w), y = y.coerceIn(0, H - t.h))
    fun moved(e: Element, x: Int, y: Int): Element = e.copy(x = x.coerceIn(0, W - e.w), y = y.coerceIn(0, H - e.h))

    // Made w by h, as near to it as the plan and the least size allow. A table
    // the back office left smaller than the least here is not made bigger by
    // being touched: it can only grow from what it is.
    fun sized(t: Table, w: Int, h: Int): Table = t.copy(
        w = w.coerceIn(minOf(MIN, t.w, W - t.x), W - t.x),
        h = h.coerceIn(minOf(MIN, t.h, H - t.y), H - t.y),
    )
    // an element is one unit thick at least
    fun sized(e: Element, w: Int, h: Int): Element = e.copy(w = w.coerceIn(1, W - e.x), h = h.coerceIn(1, H - e.y))

    // An angle turned by so many degrees, kept within the circle.
    fun turned(rotation: Int, by: Int): Int = (((rotation + by) % 360) + 360) % 360

    // A shape, as the tablet and the server know it; anything else is a square table.
    fun shape(s: String): String = if (s in SHAPES) s else "square"

    // What a table of that shape starts as: its width, its depth and its covers.
    fun tableStarts(shape: String): Triple<Int, Int, Int> = when (shape) {
        "stool" -> Triple(MIN, MIN, 1)
        "booth" -> Triple(18, 12, 4)
        else -> Triple(NEW, NEW, 4)
    }

    // What an element of that kind starts as: its width and its depth.
    fun elementStarts(kind: String): Pair<Int, Int> = when (kind) {
        "wall" -> 30 to 1
        "door" -> 8 to 2
        "window" -> 12 to 1
        else -> 24 to 6
    }

    fun kindName(kind: String): String = when (kind) { "wall" -> "Wall"; "door" -> "Door"; "window" -> "Window"; else -> "Bar counter" }

    // The first free spot on the plan for a piece of w by h, scanning left to
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
        val kind = shape(shape)
        val (w, h, _) = tableStarts(kind)
        val placed = ArrayList(room)
        val made = ArrayList<Table>()
        repeat(count.coerceIn(1, 50)) {
            while ((prefix + n).lowercase() in used) n++
            val name = (prefix + n).take(30)
            used += name.lowercase()
            val (x, y) = freeSpot(placed, w, h)
            val t = Table(newId(), name, seats.coerceIn(1, 99), kind, x, y, w, h)
            placed += t
            made += t
        }
        return made
    }

    // An element of that kind, at its usual size, where the plan has room for it among the tables.
    fun element(kind: String, tables: List<Table>, newId: () -> String): Element {
        val k = if (kind in KINDS) kind else "wall"
        val (w, h) = elementStarts(k)
        val (x, y) = freeSpot(tables, w, h)
        return Element(newId(), k, x, y, w, h)
    }

    // Why the room cannot be saved as it stands, in words; null when it can.
    // elsewhere: the names of the store's tables in other rooms, in small
    // letters. others: how many tables the other rooms hold. otherElements:
    // how many elements they hold.
    fun problem(room: List<Table>, elsewhere: Set<String>, others: Int, elements: Int = 0, otherElements: Int = 0): String? {
        val seen = HashSet<String>()
        for (t in room) {
            val name = t.name.trim()
            if (name.isEmpty()) return "Every table needs a number."
            if (!seen.add(name.lowercase())) return "Two tables are called \"$name\". Give each its own number."
            if (name.lowercase() in elsewhere) return "Table \"$name\" is in another room already. Give this one another number."
        }
        if (others + room.size > MOST) return "A store holds $MOST tables at most."
        if (otherElements + elements > MOST_ELEMENTS) return "A store holds $MOST_ELEMENTS walls, doors, windows and bars at most."
        return null
    }

    // ---- what is sent (server 0101, 0102); each is held against an example in db/tests/fixtures/till-floor ----

    // elements: what stands in the room as the plan has it, or null to say
    // nothing of them (the server then leaves them where they stand).
    fun save(
        store: String, area: String, tables: List<Table>, removed: List<String>,
        elements: List<Element>?, removedElements: List<String>, approvedBy: String?,
    ): JsonObject = buildJsonObject {
        put("store_id", store); put("area", area)
        putJsonArray("tables") {
            tables.forEach { t ->
                addJsonObject {
                    put("id", t.id); put("name", t.name.trim()); put("seats", t.seats); put("shape", t.shape)
                    put("x", t.x); put("y", t.y); put("w", t.w); put("h", t.h); put("rotation", t.rotation)
                }
            }
        }
        putJsonArray("removed") { removed.forEach { add(it) } }
        if (elements != null) {
            putJsonArray("elements") {
                elements.forEach { e ->
                    addJsonObject {
                        put("id", e.id); put("kind", e.kind)
                        put("x", e.x); put("y", e.y); put("w", e.w); put("h", e.h); put("rotation", e.rotation)
                    }
                }
            }
            putJsonArray("removed_elements") { removedElements.forEach { add(it) } }
        }
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
