package com.restopos.core.kitchen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// What a till and a kitchen screen say to each other over the restaurant's
// Wi-Fi: one message out, one answer back. What is signed with another code,
// or was changed on the way, is not read at all: a kitchen cooks what its
// screen shows.
class WireTest {
    private val code = "KTCHN234"
    private val ticket = WireTicket(
        id = "k-1", no = 12, label = "Table 4", kind = "Dine-in", covers = 2, waiter = "Aisha", remark = "Birthday",
        sentAt = 1_760_000_000_000, lines = listOf(WireLine("l-1", 2, "Dholl puri", "Extra chutney · No onion"), WireLine("l-2", 1, "Alouda")),
    )
    private val request = WireRequest(
        till = "t-1", tillName = "Terminal 01", tillCode = "T1", screen = "Grill",
        put = listOf(ticket), marks = listOf(WireMark(line = "l-9", voided = true), WireMark(ticket = "k-0", bumped = true)), after = 41,
    )

    private fun lines(text: String) = text.trimEnd('\n').split('\n')

    @Test
    fun aRequestGoesOutAndComesBackTheSame() {
        val out = Wire.encode(request, code)
        assertTrue("two lines, each ended", out.endsWith("\n") && lines(out).size == 2)
        val (first, second) = lines(out)
        assertEquals(request, Wire.decode(first, second, code))
    }

    @Test
    fun aWrongCodeIsNotRead() {
        val (first, second) = lines(Wire.encode(request, code))
        assertNull(Wire.decode(first, second, "KTCHN235"))
        assertNull(Wire.decode(first, "", code))
        assertNull(Wire.decode(first, "not a signature", code))
    }

    @Test
    fun aChangedBodyIsNotRead() {
        val (first, second) = lines(Wire.encode(request, code))
        assertNull(Wire.decode(first.replace("Dholl puri", "Dholl pur1"), second, code))
    }

    @Test
    fun whatIsSignedButIsNoRequestIsNotRead() {
        val body = """{"hello":"there"}"""
        assertNull(Wire.decode(body, Wire.sign(code, body), code))
    }

    // HMAC-SHA256, lower-case hex: worked out once with another program, so
    // that both ends cannot be wrong together
    @Test
    fun theSignatureIsHmacSha256Hex() {
        assertEquals("0d64bfd1c29b609c64acc05af6a742a819b239a7c05635ed29490d03befd6953", Wire.sign(code, "{}"))
    }

    @Test
    fun aReplyGoesOutAndComesBackTheSame() {
        val reply = WireReply(ok = true, build = 7, epoch = "e-1", seq = 9, marks = listOf(WireMark(line = "l-1", done = true)), have = listOf("k-1"))
        val out = Wire.encode(reply)
        assertTrue("one line, ended", out.endsWith("\n") && lines(out).size == 1)
        assertEquals(reply, Wire.decodeReply(out.trimEnd('\n')))
        assertEquals(WireReply(ok = false, error = "refused"), Wire.decodeReply(Wire.encode(WireReply(ok = false, error = "refused")).trim()))
    }

    // a newer build may say more than this one knows
    @Test
    fun unknownFieldsAreReadPast() {
        val reply = Wire.decodeReply("""{"ok":true,"v":1,"build":9,"epoch":"e","seq":3,"marks":[],"have":[],"something":"new"}""")
        assertNotNull(reply)
        assertEquals(3L, reply!!.seq)
        assertNull(Wire.decodeReply("not json"))
        assertNull(Wire.decodeReply(""))
    }

    // a line of the message must stay one line, whatever a waiter typed
    @Test
    fun aRemarkWithALineBreakStaysOnOneLine() {
        val odd = request.copy(put = listOf(ticket.copy(remark = "Allergy:\nnuts")))
        val out = Wire.encode(odd, code)
        assertEquals(2, lines(out).size)
        val (first, second) = lines(out)
        assertEquals("Allergy:\nnuts", Wire.decode(first, second, code)!!.put[0].remark)
    }

    @Test
    fun anAddress() {
        assertEquals("192.168.1.60" to 9310, Wire.address("192.168.1.60"))
        assertEquals("192.168.1.60" to 9400, Wire.address(" 192.168.1.60:9400 "))
        assertNull(Wire.address(null))
        assertNull(Wire.address(""))
        assertNull(Wire.address("192.168.1.60:port"))
        assertNull(Wire.address("192.168.1.60:0"))
        assertNull(Wire.address("192.168.1.60:70000"))
    }
}
