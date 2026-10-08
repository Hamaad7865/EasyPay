package com.restopos.core.kitchen

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// What a kitchen tablet does with what a till sends it, and what it tells the
// till of what the cooks did. The cooks cook what this says is on the screen:
// nothing from a stranger, nothing twice, nothing lost when a message is sent
// again.
class ScreenBookTest {
    private val code = "KTCHN234"
    private var now = 1_000_000L
    private val shelf = MemoryShelf()
    private val book = ScreenBook(shelf, code = { code }, build = 7, clock = { now })

    private fun ticket(id: String, vararg lines: String, no: Int = 1, label: String = "Table 4") =
        WireTicket(id, no, label, "Dine-in", 2, "Aisha", null, sentAt = 500, lines = lines.map { WireLine(it, 1, "Item $it") })

    private fun ask(
        till: String = "t-1", put: List<WireTicket> = emptyList(), marks: List<WireMark> = emptyList(), after: Long = 0, with: String = code, v: Int = Wire.VERSION,
        tillClock: Long = 0,
    ): WireReply =
        runBlocking {
            val out = Wire.encode(WireRequest(v = v, till = till, tillName = "Terminal $till", tillCode = till.uppercase(), screen = "Grill", put = put, marks = marks, after = after, now = tillClock), with)
            val (first, second) = out.trimEnd('\n').split('\n')
            Wire.decodeReply(book.answer(first, second).trimEnd('\n'))!!
        }

    private fun open() = runBlocking { book.open() }
    private fun line(id: String) = runBlocking { shelf.tickets().flatMap { it.lines }.first { it.id == id } }

    @Test
    fun aWrongCodeIsRefusedAndNothingIsKept() {
        val r = ask(put = listOf(ticket("k-1", "a")), with = "KTCHN235")
        assertFalse(r.ok)
        assertEquals(Wire.REFUSED, r.error)
        assertTrue(open().isEmpty())
        // and it is told nothing: not the set-up, not what the screen holds
        assertEquals("", r.epoch)
        assertTrue(r.have.isEmpty())
    }

    @Test
    fun anotherLinkVersionIsRefusedWithBothVersions() {
        val r = ask(put = listOf(ticket("k-1", "a")), v = Wire.VERSION + 1)
        assertFalse(r.ok)
        assertEquals(Wire.OTHER_VERSION, r.error)
        assertEquals(Wire.VERSION, r.v)
        assertEquals(7, r.build)
        assertTrue(open().isEmpty())
    }

    @Test
    fun aTicketPutIsOnTheScreenAndConfirmed() {
        val r = ask(put = listOf(ticket("k-1", "a", "b")))
        assertTrue(r.ok)
        assertEquals("epoch-1", r.epoch)
        assertEquals(listOf("k-1"), r.have)
        val t = open().single()
        assertEquals("Table 4", t.label)
        assertEquals("Grill", t.screen)
        assertEquals("T-1", t.tillCode)
        assertEquals(listOf("a", "b"), t.lines.map { it.id })
        // counted from when this tablet got it, on this tablet's clock
        assertEquals(now, t.receivedAt)
    }

    // A screen that was switched off gets its orders late. The guests have
    // waited all the same: the ticket's timer says how long, not 0:00.
    @Test
    fun aTicketThatWaitedForTheScreenShowsHowLongItHasWaited() {
        val tenMinutes = 10 * 60_000L
        // sent at 500 by the till's clock, put when the till's clock says ten minutes later
        ask(put = listOf(ticket("k-1", "a")), tillClock = 500 + tenMinutes)
        assertEquals(now - tenMinutes, open().single().receivedAt)
    }

    // The till's clock may be an hour ahead of this tablet's, or behind it:
    // only the difference between two times on the till's own clock is used.
    @Test
    fun aTillWhoseClockIsWrongDoesNotAgeATicket() {
        val anHourAhead = now + 3_600_000L
        val sent = WireTicket("k-1", 1, "Table 4", "Dine-in", 2, null, null, sentAt = anHourAhead, lines = listOf(WireLine("a", 1, "Item a")))
        ask(put = listOf(sent), tillClock = anHourAhead + 2_000)
        assertEquals(now - 2_000, open().single().receivedAt)
        // a till that says the ticket was sent after "now" (its clock was put back in between) waited nothing
        val odd = sent.copy(id = "k-2", lines = listOf(WireLine("b", 1, "Item b")))
        ask(put = listOf(odd), tillClock = anHourAhead - 60_000)
        assertEquals(now, open().first { it.id == "k-2" }.receivedAt)
    }

    @Test
    fun theHeaderKnowsWhatTheTillCallsThisScreen() {
        ask()
        assertEquals("Grill", book.heard.value?.screen)
        assertEquals("Terminal t-1", book.heard.value?.name)
    }

    @Test
    fun aTicketPutTwiceIsOneTicket() {
        ask(put = listOf(ticket("k-1", "a")))
        now += 5_000
        ask(put = listOf(ticket("k-1", "a")))
        assertEquals(1, open().size)
        // and it has not just arrived again
        assertEquals(1_000_000L, open().single().receivedAt)
    }

    @Test
    fun aTicketPutAgainKeepsWhatTheCookTicked() {
        ask(put = listOf(ticket("k-1", "a", "b")))
        runBlocking { book.tap("a") }
        ask(put = listOf(ticket("k-1", "a", "b")))
        assertTrue(line("a").done)
        assertFalse(line("b").done)
    }

    @Test
    fun aCooksTapComesBackOnceAskedAfter() {
        ask(put = listOf(ticket("k-1", "a")))
        runBlocking { book.tap("a") }
        val first = ask()
        assertEquals(listOf(WireMark(line = "a", done = true)), first.marks)
        assertEquals(1L, first.seq)
        // the till has it now: asked after that, there is nothing more
        val second = ask(after = first.seq)
        assertTrue(second.marks.isEmpty())
        assertEquals(1L, second.seq)
        // tapped again it is not done after all, and that is said too
        runBlocking { book.tap("a") }
        assertEquals(listOf(WireMark(line = "a", done = false)), ask(after = first.seq).marks)
    }

    @Test
    fun aMarkFromTheTillIsAppliedAndNotSentBackToIt() {
        ask(put = listOf(ticket("k-1", "a", "b")))
        val r = ask(marks = listOf(WireMark(line = "a", done = true)))
        assertTrue(line("a").done)
        assertTrue(r.marks.isEmpty())
        assertEquals(0L, r.seq)
        // the same mark again changes nothing
        ask(marks = listOf(WireMark(line = "a", done = true)))
        assertTrue(line("a").done)
    }

    @Test
    fun aVoidFromTheTillStrikesTheLineAndItCanNoLongerBeTapped() {
        ask(put = listOf(ticket("k-1", "a", "b")))
        ask(marks = listOf(WireMark(line = "a", voided = true)))
        assertTrue(line("a").voided)
        // shown struck through, never removed
        assertEquals(listOf("a", "b"), open().single().lines.map { it.id })
        runBlocking { book.tap("a") }
        assertFalse(line("a").done)
        assertTrue(ask().marks.isEmpty())
    }

    @Test
    fun bumpTakesTheTicketOffTheScreenAndTellsTheTill() {
        ask(put = listOf(ticket("k-1", "a")))
        runBlocking { book.bump("k-1") }
        assertTrue(open().isEmpty())
        val r = ask()
        assertEquals(listOf(WireMark(ticket = "k-1", bumped = true)), r.marks)
        // it is still held: the till must not send it again
        assertEquals(listOf("k-1"), r.have)
    }

    @Test
    fun recallBringsBackTheOneBumpedLast() {
        ask(put = listOf(ticket("k-1", "a", label = "Table 1"), ticket("k-2", "b", label = "Table 2")))
        runBlocking { book.bump("k-1"); now += 1000; book.bump("k-2") }
        assertTrue(runBlocking { book.canRecall() })
        assertEquals("Table 2", runBlocking { book.recallLast() })
        assertEquals(listOf("k-2"), open().map { it.id })
        assertEquals(WireMark(ticket = "k-2", bumped = false), ask().marks.last())
        assertEquals("Table 1", runBlocking { book.recallLast() })
        assertNull(runBlocking { book.recallLast() })
        assertFalse(runBlocking { book.canRecall() })
    }

    @Test
    fun aBumpOrARecallFromTheTillIsFollowed() {
        ask(put = listOf(ticket("k-1", "a")))
        ask(marks = listOf(WireMark(ticket = "k-1", bumped = true)))
        assertTrue(open().isEmpty())
        ask(marks = listOf(WireMark(ticket = "k-1", bumped = false)))
        assertEquals(1, open().size)
        // neither was the cooks' doing: the till is told nothing of it
        assertTrue(ask().marks.isEmpty())
    }

    @Test
    fun twoTillsEachGetOnlyTheirOwn() {
        ask(till = "t-1", put = listOf(ticket("k-1", "a")))
        ask(till = "t-2", put = listOf(ticket("k-2", "b")))
        assertEquals(2, open().size)
        runBlocking { book.tap("a"); book.tap("b") }
        val one = ask(till = "t-1")
        val two = ask(till = "t-2")
        assertEquals(listOf(WireMark(line = "a", done = true)), one.marks)
        assertEquals(listOf("k-1"), one.have)
        assertEquals(listOf(WireMark(line = "b", done = true)), two.marks)
        assertEquals(listOf("k-2"), two.have)
        // one till's mark does not reach another till's ticket
        ask(till = "t-1", marks = listOf(WireMark(ticket = "k-2", bumped = true), WireMark(line = "b", voided = true)))
        assertEquals(2, open().size)
        assertFalse(line("b").voided)
    }

    @Test
    fun theOldestIsFirstOnTheScreen() {
        ask(put = listOf(ticket("k-2", "b", no = 2)))
        now += 60_000
        ask(put = listOf(ticket("k-1", "a", no = 1)))
        assertEquals(listOf("k-2", "k-1"), open().map { it.id })
    }

    @Test
    fun aTabletSetUpAfreshSaysSoAndHoldsNothing() {
        ask(put = listOf(ticket("k-1", "a")))
        shelf.wipe("epoch-2")
        val r = ask()
        assertEquals("epoch-2", r.epoch)
        assertTrue(r.have.isEmpty())
        assertEquals(0L, r.seq)
    }

    @Test
    fun ticketsFromDaysGoneByAreCleared() {
        ask(put = listOf(ticket("k-1", "a")))
        now += 4 * 24 * 3_600_000L
        ask(put = listOf(ticket("k-2", "b")))
        runBlocking { book.prune() }
        assertEquals(listOf("k-2"), runBlocking { shelf.tickets() }.map { it.id })
    }
}
