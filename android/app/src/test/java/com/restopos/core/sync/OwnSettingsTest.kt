package com.restopos.core.sync

import com.restopos.core.data.PosSettings
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The day a tablet that worked on its own is connected, the first pull brings
// the server's settings: the plan, new, and the rest as old as the day the
// tablet was set up. What the tablet changed since is still in its queue, so
// it keeps its own until that has gone up.
class OwnSettingsTest {
    // the server's copy the day the business is made Premium
    private val server = """{"businessType":"restaurant","plan":"premium","setup":"done","company":{"name":"Chez Aisha"},"servicePct":0,"decimals":2}"""
    // the tablet's, after months on its own
    private val own = """{"businessType":"restaurant","plan":"offline","setup":"done","company":{"name":"Chez Aisha","address":"Royal Road","phone":"5250 1234"},""" +
        """"receipt":{"header":"Open every day","footer":"Thank you"},"servicePct":10,"onePrinter":true,"decimals":2}"""

    private fun keys(text: String) = Json.parseToJsonElement(text).jsonObject

    @Test fun the_plan_is_the_servers_and_what_the_tablet_changed_stays() {
        val s = PosSettings.parse(OwnSettings.kept(server, own))
        assertFalse(s.alone)
        assertEquals("premium", keys(OwnSettings.kept(server, own))["plan"].toString().trim('"'))
        assertEquals(listOf("Chez Aisha", "Royal Road", "5250 1234"), listOf(s.companyName, s.address, s.phone))
        assertEquals(10, keys(OwnSettings.kept(server, own))["servicePct"].toString().toInt())
        assertTrue(s.onePrinter)
        assertEquals("""{"header":"Open every day","footer":"Thank you"}""", keys(OwnSettings.kept(server, own))["receipt"].toString())
    }

    @Test fun what_only_the_server_writes_is_the_servers() {
        val from = server.replace("\"decimals\":2", "\"decimals\":0,\"tableOrdering\":true")
        val kept = keys(OwnSettings.kept(from, own))
        assertEquals("0", kept["decimals"].toString())
        assertEquals("true", kept["tableOrdering"].toString())
        assertEquals("\"done\"", kept["setup"].toString())
    }

    @Test fun a_tablet_that_changed_nothing_of_its_settings_takes_the_servers_whole() {
        assertEquals(server, OwnSettings.kept(server, """{"businessType":"restaurant","plan":"offline"}"""))
        assertEquals(server, OwnSettings.kept(server, null))
        assertEquals(server, OwnSettings.kept(server, "not json"))
    }

    @Test fun a_key_the_tablet_never_wrote_is_not_made_up() {
        val kept = keys(OwnSettings.kept(server, """{"plan":"offline","servicePct":5}"""))
        assertEquals("5", kept["servicePct"].toString())
        assertFalse("receipt" in kept)
        assertFalse("onePrinter" in kept)
        assertEquals("""{"name":"Chez Aisha"}""", kept["company"].toString())
    }
}
