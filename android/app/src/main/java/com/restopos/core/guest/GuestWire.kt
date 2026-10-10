package com.restopos.core.guest

import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ModifierEntity
import com.restopos.core.database.ModifierGroupEntity
import com.restopos.core.database.TableEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// What the till and the relay say to each other over the till's socket
// (cloudflare/relay/src/index.js), as plain functions: the menu the till
// publishes, the answer it gives an order, and what it is told.

// The till's menu as guests are shown it. The shape is the relay's
// (rules.js, readMenu), which refuses a menu that is not of it: ids of
// letters, digits, - and _, names of a length, prices in whole cents.
object GuestMenu {
    class Source(
        val name: String,
        val decimals: Int,
        val note: String,
        val accepting: Boolean,
        val tables: List<TableEntity>,
        val categories: List<CategoryEntity>,
        val items: List<ItemEntity>,
        val groups: List<ModifierGroupEntity>,
        val options: List<ModifierEntity>,
        val links: List<Pair<String, String>>, // a dish and a group it is offered with
    )

    private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val COLOUR = Regex("^#[0-9a-fA-F]{6}$")
    private fun colour(v: String?) = v?.trim()?.takeIf { COLOUR.matches(it) }?.lowercase()

    // What is left out: a dish whose price is typed at the sale or that is
    // sold by weight (a guest cannot order either), anything removed, a group
    // with no option left, and a category with no dish to show.
    fun snapshot(s: Source): JsonObject {
        val options = s.options.filter { it.deleted_at == null && ID.matches(it.id) && it.name.isNotBlank() && it.price >= 0 }.groupBy { it.group_id }
        val groups = s.groups.filter { it.deleted_at == null && ID.matches(it.id) && it.name.isNotBlank() && !options[it.id].isNullOrEmpty() }
        val groupIds = groups.map { it.id }.toSet()
        val linked = s.links.filter { it.second in groupIds }.groupBy({ it.first }, { it.second })
        val items = s.items.filter { it.deleted_at == null && ID.matches(it.id) && it.name.isNotBlank() && it.price >= 0 && !it.open_price && it.sold_by == "each" }
        val used = items.mapNotNull { it.category_id }.toSet()
        val categories = s.categories.filter { it.deleted_at == null && it.id in used && ID.matches(it.id) && it.name.isNotBlank() }.sortedWith(compareBy({ it.sort_order }, { it.name }))
        val shown = categories.map { it.id }.toSet()
        val place = HashMap<String, Int>().apply { categories.forEachIndexed { i, c -> put(c.id, i) } }
        return buildJsonObject {
            put("name", s.name.trim().take(80).ifEmpty { "Menu" })
            put("currency", "Rs")
            put("decimals", s.decimals.coerceIn(0, 3))
            put("note", s.note.take(200))
            put("accepting", s.accepting)
            put("tables", buildJsonArray {
                s.tables.filter { it.deleted_at == null && ID.matches(it.id) && it.name.isNotBlank() }.sortedWith(compareBy({ it.area }, { it.sort_order }, { it.name })).forEach { t ->
                    add(buildJsonObject { put("c", t.id); put("name", t.name.take(40)); put("area", t.area.take(40)) })
                }
            })
            put("categories", buildJsonArray {
                categories.forEach { c -> add(buildJsonObject { put("id", c.id); put("name", c.name.take(60)); colour(c.color)?.let { put("color", it) } }) }
            })
            put("groups", buildJsonArray {
                groups.forEach { g ->
                    add(buildJsonObject {
                        put("id", g.id); put("name", g.name.take(60))
                        put("min", g.min_select.coerceIn(0, 20)); put("max", OptionRules.most(g.max_select).coerceAtMost(20))
                        put("opts", buildJsonArray {
                            options[g.id].orEmpty().take(60).forEach { o -> add(buildJsonObject { put("id", o.id); put("name", o.name.take(60)); put("price", o.price) }) }
                        })
                    })
                }
            })
            put("items", buildJsonArray {
                items.sortedWith(compareBy({ place[it.category_id] ?: Int.MAX_VALUE }, { it.name.lowercase() })).forEach { i ->
                    add(buildJsonObject {
                        put("id", i.id)
                        i.category_id?.takeIf { it in shown }?.let { put("cat", it) }
                        put("name", i.name.take(80)); put("price", i.price)
                        put("groups", buildJsonArray { linked[i.id].orEmpty().distinct().take(12).forEach { add(it) } })
                        put("tags", buildJsonArray { i.tags.split(',').map { it.trim() }.filter { it.isNotEmpty() && it.length <= 24 }.take(6).forEach { add(it) } })
                        put("out", !i.is_available)
                        colour(i.tile_color)?.let { put("color", it) }
                    })
                }
            })
        }
    }
}

// What the relay tells a till.
sealed interface FromRelay {
    // the first thing said: the store's public id (the address on its table cards), whether a menu is held, how many orders wait
    data class Hello(val store: String, val hasMenu: Boolean, val waiting: Int) : FromRelay
    data class Order(val order: GuestOrder) : FromRelay
    data object MenuTaken : FromRelay
    data class MenuRefused(val why: String) : FromRelay
    // the answer stands; `late` when another till had answered first, and then `status` is what that till said
    data class Answered(val id: String, val status: String, val late: Boolean) : FromRelay
    // the relay knows no such order: it was answered long ago, or dropped as unanswered
    data class Unknown(val id: String) : FromRelay
    // another till answered it
    data class Gone(val id: String, val status: String) : FromRelay
    // the answer to "ping", and anything not understood: nothing to do
    data object Nothing : FromRelay
}

object GuestWire {
    private val json = Json { ignoreUnknownKeys = true }

    fun menu(snapshot: JsonObject): String = buildJsonObject { put("t", "menu"); put("menu", snapshot) }.toString()

    fun answer(id: String, accepted: Boolean, reason: String?): String = buildJsonObject {
        put("t", "answer"); put("id", id); put("status", if (accepted) "accepted" else "declined")
        if (!accepted) reason?.trim()?.take(140)?.takeIf { it.isNotEmpty() }?.let { put("reason", it) }
    }.toString()

    // Reads what the relay said. Anything that is not as expected is Nothing:
    // a line that cannot be read must not stop the till listening.
    fun read(text: String): FromRelay {
        if (text == "pong") return FromRelay.Nothing
        val o = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return FromRelay.Nothing
        fun str(from: JsonObject, k: String) = runCatching { from[k]?.jsonPrimitive?.contentOrNull }.getOrNull()
        return when (str(o, "t")) {
            "hello" -> FromRelay.Hello(
                str(o, "store") ?: return FromRelay.Nothing,
                runCatching { o["menu"]?.jsonPrimitive?.booleanOrNull }.getOrNull() ?: false,
                runCatching { o["waiting"]?.jsonPrimitive?.intOrNull }.getOrNull() ?: 0,
            )
            "order" -> order(runCatching { o["order"]?.jsonObject }.getOrNull())?.let { FromRelay.Order(it) } ?: FromRelay.Nothing
            "menu.ok" -> FromRelay.MenuTaken
            "menu.no" -> FromRelay.MenuRefused(str(o, "error") ?: "the menu was refused")
            "answer.ok", "answer.late" -> {
                val id = str(o, "id") ?: return FromRelay.Nothing
                FromRelay.Answered(id, str(o, "status") ?: return FromRelay.Nothing, late = str(o, "t") == "answer.late")
            }
            "answer.no" -> str(o, "id")?.let { FromRelay.Unknown(it) } ?: FromRelay.Nothing
            "gone" -> FromRelay.Gone(str(o, "id") ?: return FromRelay.Nothing, str(o, "status") ?: "accepted")
            else -> FromRelay.Nothing
        }
    }

    private fun order(o: JsonObject?): GuestOrder? {
        o ?: return null
        return runCatching {
            GuestOrder(
                id = o["id"]!!.jsonPrimitive.content,
                at = o["at"]?.jsonPrimitive?.longOrNull ?: 0,
                table = o["table"]!!.jsonPrimitive.content,
                lines = lines(o["lines"]!!.jsonArray),
            )
        }.getOrNull()?.takeIf { it.id.isNotBlank() && it.table.isNotBlank() }
    }

    // An order's lines, as the relay sends them and as the till keeps them.
    fun lines(a: JsonArray): List<GuestLine> = a.map { e ->
        val l = e.jsonObject
        GuestLine(
            item = l["item"]!!.jsonPrimitive.content,
            qty = l["qty"]!!.jsonPrimitive.intOrNull ?: 0,
            mods = l["mods"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty(),
            note = l["note"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        )
    }
    fun lines(text: String): List<GuestLine> = runCatching { lines(json.parseToJsonElement(text).jsonArray) }.getOrDefault(emptyList())
    fun write(lines: List<GuestLine>): String = buildJsonArray {
        lines.forEach { l -> add(buildJsonObject { put("item", l.item); put("qty", l.qty); put("mods", buildJsonArray { l.mods.forEach { add(it) } }); put("note", l.note) }) }
    }.toString()
}
