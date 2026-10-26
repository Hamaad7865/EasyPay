package com.restopos.core.print

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.TimeZone

// The shared examples (db/tests/fixtures/papers): a design, a paper's data,
// the business, the width, and the lines expected, each with its style. The
// back office's preview is held to the same files (web/lib/papers.test.mjs),
// so the two cannot drift. With a file named .write in that folder, the
// lines are written from this till's printing instead of compared: each one
// written so must be read by eye before it is kept.
class PapersFixtureTest {
    private val dir = File("../../db/tests/fixtures/papers")
    private val json = Json { ignoreUnknownKeys = true }
    private val pretty = Json { prettyPrint = true }
    private val line = Json { explicitNulls = false; encodeDefaults = true }
    private var zone: TimeZone? = null

    @Before
    fun mauritius() { zone = TimeZone.getDefault(); TimeZone.setDefault(TimeZone.getTimeZone("Indian/Mauritius")) }

    @After
    fun back() { TimeZone.setDefault(zone) }

    private fun shop(o: JsonObject) = Shop(
        o.str("name"), o.str("address"), o.str("phone"), o.str("brn"), o.str("vat"), o.str("header"), o.str("footer"),
        bars = o["bars"]?.jsonPrimitive?.boolean ?: false, branch = o.str("branch"),
    )
    private fun JsonObject.str(k: String) = this[k]?.jsonPrimitive?.content ?: ""

    private fun printed(f: JsonObject): List<Styled> {
        val shop = shop(f["shop"]!!.jsonObject)
        val paper = Paper(f["columns"]!!.jsonPrimitive.int, 3, true)
        val papers = (f["design"] ?: JsonNull).takeIf { it != JsonNull }?.let { d -> JsonObject(mapOf(f.str("paper") to d)).toString() }
        return if (f.str("paper") == "kitchen") {
            Docs.kitchenPage(json.decodeFromJsonElement(KitchenDoc.serializer(), f["doc"]!!), paper, Papers.kitchen(papers)).styled()
        } else {
            val d = json.decodeFromJsonElement(ReceiptDoc.serializer(), f["doc"]!!)
            Docs.receiptPage(d, shop, paper, f["decimals"]!!.jsonPrimitive.int, design = Papers.receipt(papers, shop.bars)).styled()
        }
    }

    @Test
    fun `EasyPay's designs are the two files`() {
        assertEquals(Papers.RECEIPT, Papers.receipt("""{"receipt":${File(dir, "default-receipt.json").readText()}}""", false))
        assertEquals(Papers.KITCHEN, Papers.kitchen("""{"kitchen":${File(dir, "default-kitchen.json").readText()}}"""))
    }

    @Test
    fun `every example prints the lines it expects`() {
        val write = File(dir, ".write").exists()
        val files = dir.listFiles { f -> f.name.endsWith(".json") && !f.name.startsWith("default-") }!!.sortedBy { it.name }
        assertTrue("the examples are there", files.size >= 19)
        for (file in files) {
            val f = json.parseToJsonElement(file.readText()).jsonObject
            val got = printed(f)
            if (write) {
                val input = JsonObject(f - "expect")
                val text = pretty.encodeToString(JsonElement.serializer(), input).trimEnd().removeSuffix("}").trimEnd() +
                    ",\n  \"expect\": [\n" + got.joinToString(",\n") { "    " + line.encodeToString(Styled.serializer(), it) } + "\n  ]\n}\n"
                file.writeText(text)
            } else {
                val want = json.decodeFromJsonElement(ListSerializer(Styled.serializer()), f["expect"]!!)
                assertEquals(file.name, want, got)
            }
        }
    }
}
