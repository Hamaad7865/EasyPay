package com.restopos.feature.kds

import com.restopos.core.kitchen.Heard
import com.restopos.core.kitchen.ScreenLine
import com.restopos.core.kitchen.ScreenTicket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// What a kitchen tablet puts on its board from what it holds.
class KitchenCardsTest {
    private fun ticket(id: String, till: String = "t-1", code: String = "T1", no: Int = 1, sentAt: Long = 0, receivedAt: Long = 1000, bumped: Long? = null) =
        ScreenTicket(
            id, till, "Terminal $code", code, "Grill", no, "Table 4", "Dine-in", 2, "Aisha", "Birthday", sentAt, receivedAt, bumped,
            listOf(ScreenLine("$id-a", 2, "Steak", "Rare", done = true), ScreenLine("$id-b", 1, "Salad", voided = true)),
        )

    @Test
    fun aTicketIsACardWithItsLines() {
        val c = kitchenCards(listOf(ticket("k-1", no = 12))).single()
        assertEquals("k-1", c.id)
        assertEquals("#12", c.no)
        assertEquals("Table 4", c.label)
        assertEquals("Aisha", c.waiter)
        assertEquals("Birthday", c.remark)
        assertEquals(listOf(KdsLine("k-1-a", 2, "Steak", "Rare", done = true), KdsLine("k-1-b", 1, "Salad", "", done = false, voided = true)), c.lines)
    }

    // Two tablets' clocks drift apart, most of all with the internet down. A
    // ticket sent "ten minutes ago" by a till whose clock runs ahead must not
    // arrive red: its age is this tablet's own.
    @Test
    fun aTicketsAgeIsCountedFromWhenThisTabletGotIt() {
        val c = kitchenCards(listOf(ticket("k-1", sentAt = 5, receivedAt = 777_000))).single()
        assertEquals(777_000L, c.since)
    }

    @Test
    fun theOneThatHasWaitedLongestIsFirstAndBumpedOnesAreGone() {
        val cards = kitchenCards(listOf(ticket("k-3", receivedAt = 3000), ticket("k-1", receivedAt = 1000), ticket("k-2", receivedAt = 2000, bumped = 2500)))
        assertEquals(listOf("k-1", "k-3"), cards.map { it.id })
    }

    // Two tills count their kitchen tickets separately: both have a #1.
    @Test
    fun withTwoTillsANumberSaysWhichTillsItIs() {
        val one = kitchenCards(listOf(ticket("k-1", "t-1", "T1", 1), ticket("k-2", "t-1", "T1", 2)))
        assertEquals(listOf("#1", "#2"), one.map { it.no })
        val two = kitchenCards(listOf(ticket("k-1", "t-1", "T1", 1), ticket("k-2", "t-2", "T2", 1, receivedAt = 2000)))
        assertEquals(listOf("T1 #1", "T2 #1"), two.map { it.no })
        // a second till whose only ticket was bumped no longer counts
        assertEquals(listOf("#1"), kitchenCards(listOf(ticket("k-1"), ticket("k-2", "t-2", "T2", 1, bumped = 5))).map { it.no })
    }

    // what is shown is what gets typed into the back office: the address alone
    @Test
    fun theAddressToTypeIsShownAlone() {
        assertEquals("192.168.1.60", addressOf("Wi-Fi, 192.168.1.60"))
        assertEquals("10.0.0.5", addressOf("Ethernet, 10.0.0.5"))
        assertEquals(null, addressOf("Offline"))
        assertEquals(null, addressOf("Wi-Fi"))
    }

    @Test
    fun whatTheHeaderSaysOfTheTill() {
        val h = Heard("t-1", "Terminal 01", at = 100_000)
        assertEquals("Terminal 01 · just now", h.text(100_000))
        assertEquals("Terminal 01 · just now", h.text(109_000))
        assertEquals("Terminal 01 · 40 s ago", h.text(140_000))
        // a kitchen that is not being sent orders should be able to see why
        assertEquals("No till for 2 min", h.text(100_000 + 2 * 60_000 + 5_000))
        assertEquals("No till for 3 h", h.text(100_000 + 3 * 3_600_000L))
        // a clock put back does not make it "minus" anything
        assertTrue(h.text(50_000).endsWith("just now"))
    }
}
