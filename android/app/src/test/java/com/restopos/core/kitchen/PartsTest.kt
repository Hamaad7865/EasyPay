package com.restopos.core.kitchen

import com.restopos.core.database.KdsPartEntity
import com.restopos.core.database.KdsTicketEntity
import com.restopos.core.database.PrinterEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The till's side of a kitchen screen, as rules: what a screen is still owed,
// when a kitchen ticket is done, how often to ask, and what the cashier is
// told when a screen does not answer. An order that never reached the
// kitchen, with nobody told, is the one thing this must not allow.
class PartsTest {
    private fun part(kds: String, screen: String = "grill", delivered: Boolean = false, bumped: Long? = null) =
        KdsPartEntity(kds, screen, payload = "{}", line_ids = "[]", delivered = delivered, bumped_at = bumped, created_at = 1)

    private fun screen(id: String, all: Boolean = false) = PrinterEntity(
        id = id, tenant_id = "t", store_id = "main", name = id.replaceFirstChar { it.uppercase() }, kind = "screen", address = "192.168.1.60",
        pair_code = "KTCHN234", all_items = all,
    )

    @Test
    fun whatWasNeverConfirmedIsPut() {
        val open = listOf(part("k-1", delivered = true), part("k-2"), part("k-3"))
        assertEquals(listOf("k-2", "k-3"), Parts.toPut(open).map { it.kds_id })
        // what the cooks have bumped is never sent again
        assertTrue(Parts.toPut(listOf(part("k-4", bumped = 9))).isEmpty())
    }

    @Test
    fun whatTheScreenNoLongerHoldsIsOwedAgain() {
        val open = listOf(part("k-1", delivered = true), part("k-2", delivered = true), part("k-3"), part("k-4", delivered = true, bumped = 9))
        // the screen answers that it holds k-1 only: k-2 was confirmed once and is gone from it
        assertEquals(listOf("k-2"), Parts.lost(open, listOf("k-1")))
        // not yet delivered is not lost, it is simply still to put; bumped is done with
        assertEquals(emptyList<String>(), Parts.lost(open, listOf("k-1", "k-2")))
    }

    @Test
    fun aTicketIsDoneWhenEveryScreenHasBumpedItsPart() {
        assertFalse(Parts.ticketBumped(listOf(part("k-1", "grill", bumped = 5), part("k-1", "bar"))))
        assertTrue(Parts.ticketBumped(listOf(part("k-1", "grill", bumped = 5), part("k-1", "bar", bumped = 6))))
        // a ticket with no part on any screen is not this rule's to bump: it is bumped on the till, as before
        assertFalse(Parts.ticketBumped(emptyList()))
    }

    @Test
    fun thePauseIsShortWhileOrdersAreOpenAndBacksOffWhenNothingAnswers() {
        assertEquals(3_000L, Parts.pause(openParts = 2, failures = 0))
        assertEquals(15_000L, Parts.pause(openParts = 0, failures = 0))
        // not answering: three, five, ten seconds, then every fifteen, whatever is open
        assertEquals(listOf(3_000L, 5_000L, 10_000L, 15_000L, 15_000L), (1..5).map { Parts.pause(openParts = 2, failures = it) })
    }

    @Test
    fun theWordsForAScreenThatDoesNotAnswer() {
        assertEquals(
            "Grill screen is not answering at 192.168.1.60. 2 orders are waiting for it. Check that the kitchen tablet is on, has EasyPay open and is on the same Wi-Fi.",
            Parts.trouble("Grill", "192.168.1.60", null, waiting = 2),
        )
        assertEquals(
            "Grill screen is not answering at 192.168.1.60. 1 order is waiting for it. Check that the kitchen tablet is on, has EasyPay open and is on the same Wi-Fi.",
            Parts.trouble("Grill", "192.168.1.60", null, waiting = 1),
        )
        // nothing waiting: it is still worth knowing before the next order
        assertEquals(
            "Grill screen is not answering at 192.168.1.60. Check that the kitchen tablet is on, has EasyPay open and is on the same Wi-Fi.",
            Parts.trouble("Grill", "192.168.1.60", null, waiting = 0),
        )
        // a screen that was named "Kitchen screen" is not called a screen twice
        assertTrue(Parts.trouble("Kitchen screen", "192.168.1.60", null, 0)!!.startsWith("Kitchen screen is not answering"))
    }

    @Test
    fun theWordsForAScreenWithNoUsableAddress() {
        assertEquals("Grill screen has no address the till can use. Set it in the back office, under Printers.", Parts.trouble("Grill", null, null, 3))
        assertEquals("Grill screen has no address the till can use. Set it in the back office, under Printers.", Parts.trouble("Grill", "192.168.1.60:port", null, 0))
    }

    @Test
    fun theWordsForARefusedCodeAndForAnotherVersion() {
        assertEquals(
            "Grill screen refused this till: the pairing code is not the one its tablet shows. Check the code in the back office, under Printers.",
            Parts.trouble("Grill", "192.168.1.60", WireReply(ok = false, error = Wire.REFUSED), 1),
        )
        // the screen speaks a newer version of the link: it is the till that is behind
        assertEquals(
            "This till's EasyPay is too old for Grill screen. Update EasyPay on this till.",
            Parts.trouble("Grill", "192.168.1.60", WireReply(ok = false, error = Wire.OTHER_VERSION, v = Wire.VERSION + 1), 1),
        )
        assertEquals(
            "The EasyPay on Grill screen's tablet is too old for this till. Update EasyPay on the kitchen tablet.",
            Parts.trouble("Grill", "192.168.1.60", WireReply(ok = false, error = Wire.OTHER_VERSION, v = Wire.VERSION - 1), 1),
        )
        assertNull(Parts.trouble("Grill", "192.168.1.60", WireReply(ok = true), 4))
    }

    // One send, as each screen's part of it: frozen as it is sent.
    @Test
    fun aSendIsSplitIntoEachScreensPart() {
        val ticket = KdsTicketEntity("k-1", "order-1", no = 12, label = "Table 4", kind = "Dine-in", covers = 2, created_at = 777, waiter = "Aisha", remark = "Birthday")
        val lines = listOf(
            WireLine("l-1", 2, "Steak", "Rare") to listOf("grill"),
            WireLine("l-2", 1, "Beer") to listOf("bar"),
            WireLine("l-3", 1, "Gift card") to null,
        )
        val parts = Parts.of(ticket, lines, listOf(screen("grill"), screen("pass", all = true), screen("cold")), now = 900)
        assertEquals(listOf("grill", "pass"), parts.map { it.screen_id })
        assertTrue(parts.all { it.kds_id == "k-1" && !it.delivered && it.bumped_at == null && it.created_at == 900L })
        val grill = Wire.decodeTicket(parts[0].payload)!!
        assertEquals(WireTicket("k-1", 12, "Table 4", "Dine-in", 2, "Aisha", "Birthday", 777, listOf(WireLine("l-1", 2, "Steak", "Rare"))), grill)
        assertEquals(listOf("l-1"), Parts.lineIds(parts[0]))
        assertEquals(listOf("l-1", "l-2", "l-3"), Wire.decodeTicket(parts[1].payload)!!.lines.map { it.id })
        assertEquals(listOf("l-1", "l-2", "l-3"), Parts.lineIds(parts[1]))
        // nothing for any screen: no part at all
        assertTrue(Parts.of(ticket, listOf(WireLine("l-2", 1, "Beer") to listOf("bar")), listOf(screen("grill")), 900).isEmpty())
    }

    // A part is sent as it was when the order was sent. Put again later, to a
    // tablet set up afresh, it must not bring a voided item back as one to cook.
    @Test
    fun aPartPutAgainTakesHowItsLinesStandNow() {
        val marks = Parts.standing(listOf(Triple("l-1", false, false), Triple("l-2", true, false), Triple("l-3", false, true), Triple("l-4", true, true)))
        assertEquals(
            listOf(WireMark(line = "l-2", done = true), WireMark(line = "l-3", voided = true), WireMark(line = "l-4", voided = true)),
            marks,
        )
        // the first time, nothing has happened yet: nothing is said
        assertTrue(Parts.standing(listOf(Triple("l-1", false, false))).isEmpty())
    }

    @Test
    fun aMarkIsKeptAsTextAndReadBack() {
        val m = WireMark(line = "l-1", voided = true)
        assertEquals(m, Wire.decodeMark(Wire.encodeMark(m)))
        assertNull(Wire.decodeMark("not json"))
        assertNull(Wire.decodeTicket("not json"))
    }
}
