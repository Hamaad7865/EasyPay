package com.restopos.core.guest

import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ModifierEntity
import com.restopos.core.database.ModifierGroupEntity
import com.restopos.core.database.TableEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// Ordering from the table, the till's rules: the least and most of a group of
// options, a guest's order held against the till's own menu, the menu the
// till publishes, and what it and the relay say to each other. The one thing
// these must not allow is an order going onto a table at a price or with a
// dish the till would not have rung up itself.
class GuestTest {
    private fun table(id: String, name: String, area: String = "Main", sort: Int = 0, gone: Boolean = false) =
        TableEntity(id = id, tenant_id = "t", store_id = "s", name = name, area = area, sort_order = sort, deleted_at = if (gone) "2026-10-10" else null)
    private fun cat(id: String, name: String, color: String? = null, sort: Int = 0) = CategoryEntity(id = id, tenant_id = "t", name = name, color = color, sort_order = sort)
    private fun item(
        id: String, name: String, price: Long, cat: String? = "c-main", on: Boolean = true, tags: String = "", tile: String? = null,
        open: Boolean = false, soldBy: String = "each", gone: Boolean = false,
    ) = ItemEntity(
        id = id, tenant_id = "t", category_id = cat, name = name, price = price, is_available = on, tile_color = tile, tags = tags,
        open_price = open, sold_by = soldBy, deleted_at = if (gone) "2026-10-10" else null,
    )
    private fun group(id: String, name: String, min: Int, max: Int) = ModifierGroupEntity(id = id, tenant_id = "t", name = name, min_select = min, max_select = max)
    private fun opt(id: String, group: String, name: String, price: Long = 0) = ModifierEntity(id = id, tenant_id = "t", group_id = group, name = name, price = price)

    private val spice = group("g-spice", "Curry spice", 1, 1)
    private val addOns = group("g-add", "Add-ons", 0, 0)
    private val extras = group("g-extra", "Extras", 0, 3)
    private val options = listOf(opt("o-mild", "g-spice", "Mild"), opt("o-hot", "g-spice", "Hot"), opt("o-rice", "g-add", "Extra rice", 4000),
        opt("o-egg", "g-extra", "Fried egg", 3000), opt("o-sauce", "g-extra", "Extra sauce", 2000), opt("o-chutney", "g-extra", "Chutney", 1500), opt("o-achard", "g-extra", "Achard", 2000))
    private val curry = item("i-curry", "Cari poulet", 38000, tags = "Veg, Signature")
    private val fish = item("i-fish", "Vindaye", 42000, on = false, tile = "#2F7FA3")
    private val alouda = item("i-alouda", "Alouda", 9000, cat = "c-drinks")
    private val wok = item("i-wok", "Mine frit", 28000)

    private fun book() = MenuBook(
        tables = mapOf("T-1" to "Table 1", "T-2" to "Table 2"),
        items = listOf(curry, fish, alouda, wok, item("i-open", "Service", 0, open = true), item("i-gone", "Old dish", 100, gone = true)).associateBy { it.id },
        groupsOf = mapOf("i-curry" to listOf(spice, addOns), "i-wok" to listOf(extras)),
        optionsOf = options.groupBy { it.group_id },
    )
    private fun order(vararg lines: GuestLine, table: String = "T-1") = GuestOrder("o1", 1L, table, lines.toList())
    private fun line(item: String, qty: Int = 1, mods: List<String> = emptyList(), note: String = "") = GuestLine(item, qty, mods, note)
    private fun why(c: Checked) = (c as Checked.Fault).why

    // ---- options ----

    private fun one(vararg options: String) = options.associateWith { 1 }

    @Test
    fun aTapOnAnOptionWhereOneIsNeededMovesThePickAndNeverClearsIt() {
        assertEquals(one("hot"), OptionRules.tap(one("mild"), "hot", min = 1, max = 1))
        assertEquals(one("mild"), OptionRules.tap(one("mild"), "mild", min = 1, max = 1))
        assertEquals(one("mild"), OptionRules.tap(emptyMap(), "mild", min = 1, max = 1))
    }

    @Test
    fun whereNoneIsNeededATapOnThePickedOneClearsIt() {
        assertEquals(emptyMap<String, Int>(), OptionRules.tap(one("ice"), "ice", min = 0, max = 1))
        assertEquals(one("less"), OptionRules.tap(one("ice"), "less", min = 0, max = 1))
    }

    @Test
    fun whereSeveralMayBePickedATapAddsOrTakesAwayAndStopsAtTheMost() {
        assertEquals(one("egg", "sauce"), OptionRules.tap(one("egg"), "sauce", min = 0, max = 3))
        assertEquals(one("sauce"), OptionRules.tap(one("egg", "sauce"), "egg", min = 0, max = 3))
        assertEquals(one("a", "b", "c"), OptionRules.tap(one("a", "b", "c"), "d", min = 0, max = 3))
        assertTrue(OptionRules.tooFew(1, 0)); assertFalse(OptionRules.tooFew(1, 1)); assertFalse(OptionRules.tooFew(0, 0))
        assertTrue(OptionRules.tooMany(3, 4)); assertFalse(OptionRules.tooMany(3, 3))
    }

    // The add-on editor says of it: "Most 0 is as many as they like". The
    // sheet took it for one, so a second add-on took the place of the first.
    @Test
    fun aMostOfNoneIsAsManyAsTheyLike() {
        assertEquals(one("rice", "egg"), OptionRules.tap(one("rice"), "egg", min = 0, max = 0))
        assertEquals(mapOf("rice" to 30), OptionRules.more(mapOf("rice" to 29), "rice", max = 0))
        assertFalse(OptionRules.tooMany(0, 2)); assertFalse(OptionRules.tooMany(0, 40))
        assertTrue(OptionRules.room(mapOf("rice" to 12), max = 0))
    }

    // The owner: "if the customer is buying grillade + sausage as add on. We
    // need to be able to select how much sausages he wants".
    @Test
    fun anAddOnCanBeTakenSeveralTimesAndEachOneCountsTowardsTheMost() {
        val three = OptionRules.more(OptionRules.more(one("sausage"), "sausage", max = 3), "sausage", max = 3)
        assertEquals(mapOf("sausage" to 3), three)
        assertEquals(3, OptionRules.count(three))
        // three sausages fill "up to 3": no fourth, and no egg beside them
        assertEquals(three, OptionRules.more(three, "sausage", max = 3))
        assertEquals(three, OptionRules.tap(three, "egg", min = 0, max = 3))
        assertFalse(OptionRules.room(three, max = 3)); assertTrue(OptionRules.room(mapOf("sausage" to 2), max = 3))
        // two sausages and an egg are three as well
        assertEquals(mapOf("sausage" to 2, "egg" to 1), OptionRules.tap(mapOf("sausage" to 2), "egg", min = 0, max = 3))
    }

    @Test
    fun oneFewerOfAnAddOnAndTheLastOneTakesItOff() {
        assertEquals(mapOf("sausage" to 2), OptionRules.fewer(mapOf("sausage" to 3), "sausage"))
        assertEquals(one("egg"), OptionRules.fewer(one("egg", "sausage"), "sausage"))
        // a tap on a picked one takes all of it off, however many
        assertEquals(one("egg"), OptionRules.tap(mapOf("sausage" to 3, "egg" to 1), "sausage", min = 0, max = 0))
        // nothing is done to one that is not picked
        assertEquals(one("egg"), OptionRules.fewer(one("egg"), "sausage"))
        assertEquals(one("egg"), OptionRules.more(one("egg"), "sausage", max = 0))
    }

    @Test
    fun whereOneThingIsChosenNothingIsCountedAndNoAddOnGoesPastNinetyNine() {
        assertEquals(one("mild"), OptionRules.more(one("mild"), "mild", max = 1))
        assertEquals(mapOf("rice" to 99), OptionRules.more(mapOf("rice" to 99), "rice", max = 0))
    }

    // The owner, of sauces with a choice called All: "if we select mayo and
    // select all it puts mayo and all we need a way when selecting all the
    // rest should be deselected and when selecting mayo all should be
    // deselected".
    @Test
    fun aChoicePickedAloneTakesTheOthersOffAndAnotherTakesItOff() {
        val alone = setOf("all")
        assertEquals(one("all"), OptionRules.tap(mapOf("mayo" to 2, "ketchup" to 1), "all", min = 0, max = 0, alone = alone))
        assertEquals(one("mayo"), OptionRules.tap(one("all"), "mayo", min = 0, max = 0, alone = alone))
        // the others still go together, and a tap on All takes it off
        assertEquals(one("mayo", "ketchup"), OptionRules.tap(one("mayo"), "ketchup", min = 0, max = 0, alone = alone))
        assertEquals(emptyMap<String, Int>(), OptionRules.tap(one("all"), "all", min = 0, max = 0, alone = alone))
        // it goes on even where the others have filled the group
        assertEquals(one("all"), OptionRules.tap(one("mayo", "ketchup"), "all", min = 1, max = 2, alone = alone))
        // there is one of it or none
        assertEquals(one("all"), OptionRules.more(one("all"), "all", max = 0, alone = alone))
        assertEquals(mapOf("mayo" to 2), OptionRules.more(one("mayo"), "mayo", max = 0, alone = alone))
        // where one thing is chosen the mark changes nothing
        assertEquals(one("mayo"), OptionRules.tap(one("all"), "mayo", min = 1, max = 1, alone = alone))
    }

    // A phone takes each option once: "as many as they like" is one of each there.
    @Test
    fun whatAPhoneIsToldOfAGroupsMost() {
        assertEquals(5, OptionRules.mostOnAPhone(max = 0, options = 5))
        assertEquals(3, OptionRules.mostOnAPhone(max = 3, options = 5))
        assertEquals(20, OptionRules.mostOnAPhone(max = 0, options = 50))
        assertEquals(1, OptionRules.mostOnAPhone(max = 0, options = 0))
    }

    // ---- an order held against the menu ----

    @Test
    fun anOrderIsMadeReadyAtTheTillsOwnPricesWithTheOptionsNamed() {
        val c = GuestCheck.of(order(line("i-curry", 2, listOf("o-rice", "o-hot"), "  no onion "), line("i-alouda")), book()) as Checked.Ready
        assertEquals("T-1", c.table)
        assertEquals(listOf("Hot", "Extra rice"), c.lines[0].mods.map { it.name })
        assertEquals(42000L, c.lines[0].unit)
        assertEquals(84000L, c.lines[0].total)
        // onto the table's order in the till's own measure of a quantity: thousandths
        assertEquals(2000, c.lines[0].thousandths)
        assertEquals(1000, c.lines[1].thousandths)
        assertEquals("no onion", c.lines[0].note)
        assertEquals(null, c.lines[1].note)
        assertEquals(93000L, c.total)
    }

    @Test
    fun whatTheMenuNoLongerHasIsNotTakenAndTheCashierIsToldWhich() {
        val b = book()
        assertEquals("This table is no longer on the floor plan.", why(GuestCheck.of(order(line("i-alouda"), table = "T-9"), b)))
        assertEquals("A dish in this order is no longer on the menu.", why(GuestCheck.of(order(line("i-ghost")), b)))
        assertEquals("A dish in this order is no longer on the menu.", why(GuestCheck.of(order(line("i-gone")), b)))
        assertEquals("Vindaye is sold out.", why(GuestCheck.of(order(line("i-alouda"), line("i-fish")), b)))
        assertTrue(why(GuestCheck.of(order(line("i-open")), b)).startsWith("Service has its price typed at the sale"))
        assertEquals("Alouda: an option is no longer offered.", why(GuestCheck.of(order(line("i-alouda", mods = listOf("o-mild"))), b)))
        assertEquals("The order is empty.", why(GuestCheck.of(order(), b)))
    }

    @Test
    fun aGroupsLeastAndMostAreKeptAsOnTheOrderScreen() {
        val b = book()
        assertEquals("Cari poulet: Curry spice was not chosen.", why(GuestCheck.of(order(line("i-curry")), b)))
        assertEquals("Cari poulet: too many of Curry spice.", why(GuestCheck.of(order(line("i-curry", mods = listOf("o-mild", "o-hot"))), b)))
        assertTrue(GuestCheck.of(order(line("i-wok", mods = listOf("o-egg", "o-sauce", "o-chutney"))), b) is Checked.Ready)
        assertEquals("Mine frit: too many of Extras.", why(GuestCheck.of(order(line("i-wok", mods = listOf("o-egg", "o-sauce", "o-chutney", "o-achard"))), b)))
        assertTrue(GuestCheck.of(order(line("i-wok")), b) is Checked.Ready)
        assertEquals("Mine frit: an option is there twice.", why(GuestCheck.of(order(line("i-wok", mods = listOf("o-egg", "o-egg"))), b)))
    }

    @Test
    fun quantitiesAndLinesHaveTheirLimits() {
        val b = book()
        assertTrue(why(GuestCheck.of(order(line("i-alouda", 0)), b)).contains("quantity"))
        assertTrue(why(GuestCheck.of(order(line("i-alouda", 21)), b)).contains("quantity"))
        assertTrue(GuestCheck.of(order(line("i-alouda", 20)), b) is Checked.Ready)
        assertEquals("The order has too many lines.", why(GuestCheck.of(order(*Array(41) { line("i-alouda") }), b)))
        val long = GuestCheck.of(order(line("i-alouda", note = "x".repeat(500))), b) as Checked.Ready
        assertEquals(140, long.lines[0].note!!.length)
    }

    // A guest's note is one line of plain words on the kitchen ticket: a line
    // break printed a line that looked like the till's own, and a control
    // byte reached the printer (the drawer opens on five of them).
    @Test
    fun aGuestsNoteIsOneLineOfPlainWords() {
        val c = GuestCheck.of(order(line("i-alouda", note = "no ice\nTABLE 9 PAID\r\n\u001Bp\u0000\u0019ú")), book()) as Checked.Ready
        assertEquals("no ice TABLE 9 PAID p ú", c.lines[0].note)
    }

    // ---- the menu the till publishes ----

    private fun source() = GuestMenu.Source(
        name = "Le Flamboyant", decimals = 2, note = "Prices in Mauritian rupees.", accepting = true,
        tables = listOf(table("T-2", "Table 2", sort = 2), table("T-9", "Terrace 1", area = "Terrace"), table("T-1", "Table 1", sort = 1), table("T-0", "Old table", gone = true)),
        categories = listOf(cat("c-drinks", "Drinks", sort = 2), cat("c-main", "Mains", "#C4523A", 1), cat("c-empty", "Empty", sort = 0)),
        items = listOf(alouda, fish, curry, item("i-bread", "Bread", 2000, cat = null), item("i-open", "Service", 0, open = true),
            item("i-weight", "Cheese", 900, soldBy = "weight"), item("i-gone", "Old dish", 100, gone = true)),
        groups = listOf(spice, addOns, group("g-none", "Nothing left", 0, 1)),
        options = options.filter { it.group_id != "g-extra" },
        links = listOf("i-curry" to "g-spice", "i-curry" to "g-add", "i-curry" to "g-none"),
    )

    // The relay's own tests read the same file (cloudflare/relay/src/rules.test.mjs)
    // and take it whole: what the till writes is what the relay reads.
    private fun fixture(): String {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val f = File(dir, "cloudflare/relay/test/till-menu.json")
            if (f.isFile) return f.readText()
            dir = dir.parentFile
        }
        error("cloudflare/relay/test/till-menu.json was not found above " + File("").absolutePath)
    }

    @Test
    fun theMenuIsPublishedInTheShapeTheRelayReads() {
        assertEquals(Json.parseToJsonElement(fixture()), GuestMenu.snapshot(source()))
    }

    @Test
    fun whatAGuestCannotOrderIsLeftOutOfTheMenu() {
        val m = GuestMenu.snapshot(source())
        val items = m["items"]!!.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content }
        assertEquals(listOf("i-curry", "i-fish", "i-alouda", "i-bread"), items)
        assertEquals(listOf("c-main", "c-drinks"), m["categories"]!!.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content })
        assertEquals(listOf("T-1", "T-2", "T-9"), m["tables"]!!.jsonArray.map { it.jsonObject["c"]!!.jsonPrimitive.content })
        assertEquals(listOf("g-spice", "g-add"), m["groups"]!!.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content })
    }

    @Test
    fun aTillThatHasStoppedTakingOrdersSaysSoInItsMenu() {
        val s = source()
        val closed = GuestMenu.Source(s.name, s.decimals, s.note, false, s.tables, s.categories, s.items, s.groups, s.options, s.links)
        assertEquals("false", GuestMenu.snapshot(closed)["accepting"]!!.jsonPrimitive.content)
    }

    // ---- what the till and the relay say ----

    @Test
    fun whatTheRelaySaysIsRead() {
        assertEquals(FromRelay.Hello("demostoreaaaaaaa", true, 2), GuestWire.read("""{"t":"hello","store":"demostoreaaaaaaa","menu":true,"waiting":2}"""))
        val o = GuestWire.read("""{"t":"order","order":{"id":"abcdefghijkl","at":1791658000000,"table":"T-1","lines":[{"item":"i-curry","qty":2,"mods":["o-hot","o-rice"],"note":"no onion"},{"item":"i-alouda","qty":1,"mods":[],"note":""}]}}""")
        assertEquals(FromRelay.Order(GuestOrder("abcdefghijkl", 1791658000000, "T-1", listOf(GuestLine("i-curry", 2, listOf("o-hot", "o-rice"), "no onion"), GuestLine("i-alouda", 1, emptyList(), "")))), o)
        assertEquals(FromRelay.MenuTaken, GuestWire.read("""{"t":"menu.ok","items":43,"tables":3}"""))
        assertEquals(FromRelay.MenuRefused("a dish is not as expected"), GuestWire.read("""{"t":"menu.no","error":"a dish is not as expected"}"""))
        assertEquals(FromRelay.Answered("abcdefghijkl", "accepted", late = false), GuestWire.read("""{"t":"answer.ok","id":"abcdefghijkl","status":"accepted"}"""))
        assertEquals(FromRelay.Answered("abcdefghijkl", "declined", late = true), GuestWire.read("""{"t":"answer.late","id":"abcdefghijkl","status":"declined"}"""))
        assertEquals(FromRelay.Unknown("abcdefghijkl"), GuestWire.read("""{"t":"answer.no","id":"abcdefghijkl","error":"no such order"}"""))
        assertEquals(FromRelay.Gone("abcdefghijkl", "accepted"), GuestWire.read("""{"t":"gone","id":"abcdefghijkl","status":"accepted"}"""))
    }

    @Test
    fun whatCannotBeReadIsNothingAndNeverStopsTheTillListening() {
        for (said in listOf("pong", "", "not json", "[]", "{}", """{"t":"something new"}""", """{"t":"hello"}""", """{"t":"order"}""",
            """{"t":"order","order":{"id":"x","table":"T-1"}}""", """{"t":"order","order":{"id":"","table":"T-1","lines":[]}}""", """{"t":"answer.ok"}""")) {
            assertEquals(said, FromRelay.Nothing, GuestWire.read(said))
        }
    }

    @Test
    fun theTillsAnswerAndItsMenuGoOutAsTheRelayExpects() {
        assertEquals("""{"t":"answer","id":"abcdefghijkl","status":"accepted"}""", GuestWire.answer("abcdefghijkl", true, "ignored"))
        assertEquals("""{"t":"answer","id":"abcdefghijkl","status":"declined","reason":"Sold out"}""", GuestWire.answer("abcdefghijkl", false, "  Sold out "))
        assertEquals("""{"t":"answer","id":"abcdefghijkl","status":"declined"}""", GuestWire.answer("abcdefghijkl", false, " "))
        val sent = Json.parseToJsonElement(GuestWire.menu(GuestMenu.snapshot(source()))).jsonObject
        assertEquals("menu", sent["t"]!!.jsonPrimitive.content)
        assertEquals("Le Flamboyant", sent["menu"]!!.jsonObject["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun anOrdersLinesAreKeptOnTheTabletAndReadBackAsTheyWere() {
        val lines = listOf(GuestLine("i-curry", 2, listOf("o-hot", "o-rice"), "no \"onion\""), GuestLine("i-alouda", 1, emptyList(), ""))
        assertEquals(lines, GuestWire.lines(GuestWire.write(lines)))
        assertEquals(emptyList<GuestLine>(), GuestWire.lines("not json"))
    }

    // The number on the phone key: an order counts as new until the list has
    // been opened on it, and as waiting until it is answered.
    @Test
    fun `the phone key counts what nobody has looked at, and what still waits`() {
        assertEquals(GuestCount(0, 0), GuestSeen.count(emptyList(), emptySet()))
        assertEquals(GuestCount(1, 1), GuestSeen.count(listOf("a"), emptySet()))
        assertEquals(GuestCount(2, 2), GuestSeen.count(listOf("a", "b"), emptySet()))
        // the list was opened on the first; a second came after
        assertEquals(GuestCount(2, 1), GuestSeen.count(listOf("a", "b"), setOf("a")))
        // looked at and not answered: it still waits
        assertEquals(GuestCount(2, 0), GuestSeen.count(listOf("a", "b"), setOf("a", "b")))
        // answered ones are no longer in the list, whatever was looked at
        assertEquals(GuestCount(1, 1), GuestSeen.count(listOf("c"), setOf("a", "b")))
    }
}
