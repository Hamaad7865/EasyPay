package com.restopos.core.data

import com.restopos.core.data.GoLiveRules.Noted
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// Go live on a tablet that was setting up: which kinds of change go from its
// queue with the sales, and what goes back on the shelf.
class GoLiveRulesTest {
    @Test
    fun noKindIsInBothLists() = assertEquals(emptySet<String>(), GoLiveRules.RUNG_UP intersect GoLiveRules.SET_UP)

    // Every kind of change the code puts in the queue, read from the code
    // itself: op("…"), OutboxEntity(Uuid7.next(), "…") (across lines too),
    // and what the tablet answers by itself. A new kind fails here until it
    // is said to be rung up or set up.
    @Test
    fun everyKindQueuedIsInOneList() {
        val code = File("src/main/java").walkTopDown().filter { it.isFile && it.extension == "kt" }.joinToString("\n") { it.readText() }
        val queued = Regex("""(?:\bop\(\s*|OutboxEntity\(\s*Uuid7\.next\(\),\s*)"([a-z_]+\.[a-z_]+)"""").findAll(code).map { it.groupValues[1] }.toSet() + LocalAnswers.KINDS
        assertTrue("found ${queued.size}: too few to be the whole code", queued.size > 60)
        assertEquals(emptySet<String>(), queued - GoLiveRules.RUNG_UP - GoLiveRules.SET_UP)
    }

    @Test
    fun aKindNotKnownStays() {
        assertTrue(GoLiveRules.goes("receipt.create"))
        assertTrue(GoLiveRules.goes("request.answer"))
        assertFalse(GoLiveRules.goes("item.save"))
        assertFalse(GoLiveRules.goes("count.complete"))
        assertFalse(GoLiveRules.goes("something.new"))
    }

    @Test
    fun salesAndRefundsAreUndone() {
        val back = GoLiveRules.putBack(listOf(Noted("mug", "", -2000, 10), Noted("mug", "", 1000, 20), Noted("tea", "v1", -500, 30)), emptyMap())
        assertEquals(mapOf(("mug" to "") to 1000, ("tea" to "v1") to 500), back)
    }

    // the count found what was there and set the level: a sale before it is no longer in the level
    @Test
    fun aSaleBeforeACountStaysOut() {
        val back = GoLiveRules.putBack(listOf(Noted("mug", "", -1000, 10), Noted("mug", "", -3000, 50)), mapOf(("mug" to "") to 30L))
        assertEquals(mapOf(("mug" to "") to 3000), back)
    }

    @Test
    fun aCountOfOneVariantLeavesTheOthers() {
        val back = GoLiveRules.putBack(listOf(Noted("shirt", "s", -1000, 10), Noted("shirt", "m", -1000, 10)), mapOf(("shirt" to "s") to 30L))
        assertEquals(mapOf(("shirt" to "m") to 1000), back)
    }

    @Test
    fun whatCancelsOutIsNotWritten() =
        assertEquals(emptyMap<Pair<String, String>, Int>(), GoLiveRules.putBack(listOf(Noted("mug", "", -1000, 10), Noted("mug", "", 1000, 20)), emptyMap()))
}
