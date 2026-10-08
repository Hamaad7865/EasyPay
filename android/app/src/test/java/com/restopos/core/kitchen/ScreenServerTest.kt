package com.restopos.core.kitchen

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket

// The two ends talking for real, over this machine's own loopback address: a
// kitchen screen listening, a till connecting, one request and one reply.
class ScreenServerTest {
    private val code = "KTCHN234"
    private val shelf = MemoryShelf()
    private val book = ScreenBook(shelf, code = { code }, build = 7)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    // port 0: whichever is free, so two test runs never meet
    private val server = ScreenServer(0, readMs = 400) { first, second -> book.answer(first, second) }.also { it.start(scope) }

    @After
    fun stop() { server.stop(); scope.cancel() }

    private fun request(put: List<WireTicket> = emptyList(), after: Long = 0, till: String = "t-1") =
        Wire.encode(WireRequest(till = till, tillName = "Terminal 01", tillCode = "T1", screen = "Grill", put = put, after = after), code)

    private fun ticket(id: String, vararg lines: String) =
        WireTicket(id, 1, "Table 4", "Dine-in", 2, null, null, sentAt = 1, lines = lines.map { WireLine(it, 1, "Item $it") })

    private fun exchange(payload: String): WireReply = Wire.decodeReply(ScreenClient.exchange("127.0.0.1", server.port, payload))!!

    @Test
    fun aPutArrivesAndIsAnswered() {
        assertTrue(server.port > 0)
        val r = exchange(request(put = listOf(ticket("k-1", "a", "b"))))
        assertTrue(r.ok)
        assertEquals(listOf("k-1"), r.have)
        assertEquals(listOf("a", "b"), runBlocking { book.open() }.single().lines.map { it.id })
    }

    @Test
    fun aTapOnTheScreenReachesTheTillAtItsNextExchange() {
        exchange(request(put = listOf(ticket("k-1", "a"))))
        runBlocking { book.tap("a") }
        val r = exchange(request())
        assertEquals(listOf(WireMark(line = "a", done = true)), r.marks)
        assertTrue(exchange(request(after = r.seq)).marks.isEmpty())
    }

    @Test
    fun aStoppedServerDoesNotAnswer() {
        val port = server.port
        server.stop()
        assertFalse(server.listening)
        try {
            ScreenClient.exchange("127.0.0.1", port, request(), connectMs = 500, readMs = 500)
            fail("something answered")
        } catch (e: IOException) {
            // what the till takes for "the kitchen screen is not answering"
        }
    }

    @Test
    fun aRequestTooLongToBeOneIsDroppedNotRead() {
        val huge = "x".repeat(ScreenServer.MAX_LINE + 10) + "\nsignature\n"
        try {
            ScreenClient.exchange("127.0.0.1", server.port, huge, readMs = 1500)
            fail("it was answered")
        } catch (e: IOException) {
        }
        assertTrue(runBlocking { shelf.tickets() }.isEmpty())
        // and the screen goes on answering
        assertTrue(exchange(request()).ok)
    }

    @Test
    fun aCallerThatSaysNothingDoesNotHoldTheScreenUp() {
        Socket().use { silent ->
            silent.connect(InetSocketAddress("127.0.0.1", server.port), 500)
            assertTrue(exchange(request(put = listOf(ticket("k-1", "a")))).ok)
        }
    }

    @Test
    fun severalTillsAtOnceAreAllAnswered() {
        val replies = runBlocking {
            (1..8).map { i -> async(Dispatchers.IO) { exchange(request(put = listOf(ticket("k-$i", "l-$i")), till = "t-$i")) } }.awaitAll()
        }
        assertTrue(replies.all { it.ok })
        assertEquals(8, runBlocking { book.open() }.size)
    }

    @Test
    fun aPortThatIsTakenCannotBeHadTwice() {
        val second = ScreenServer(server.port) { _, _ -> "" }
        try {
            second.start(scope)
            fail("two screens on one port")
        } catch (e: IOException) {
        } finally {
            second.stop()
        }
        assertTrue(exchange(request()).ok)
    }
}
