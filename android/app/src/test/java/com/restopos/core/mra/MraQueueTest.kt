package com.restopos.core.mra

import com.restopos.core.database.MraInvoiceEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// What a till sends the MRA next, and what an answer means (the guide's 9.1:
// once later, never in a loop).
class MraQueueTest {
    private fun doc(counter: Long, type: String = "STD", ref: String? = null, ebs: String = "E1", status: String = "waiting", unanswered: Int = 0) =
        MraInvoiceEntity("id$counter", "t", "s", "d", ebs, "id$counter", type, counter, "S-T1-$counter", ref, "0", "{}", counter, status, unanswered)

    @Test fun theOldestFirst() =
        assertEquals(listOf(1L, 2L, 3L), MraQueue.next(listOf(doc(3), doc(1), doc(2)), emptyMap(), "E1").map { it.counter })

    @Test fun atMost500ARequest() =
        assertEquals(500, MraQueue.next((1L..620L).map { doc(it) }, emptyMap(), "E1").size)

    // an original before its refund
    @Test fun aCreditNoteWaitsForItsSaleOnThisTill() {
        val crn = doc(5, "CRN", ref = "S-T1-1")
        assertEquals(listOf(1L), MraQueue.next(listOf(doc(1), crn, doc(6)), mapOf("S-T1-1" to "waiting"), "E1").map { it.counter })
        assertEquals(listOf(5L, 6L), MraQueue.next(listOf(crn, doc(6)), mapOf("S-T1-1" to "fiscalised"), "E1").map { it.counter })
        assertEquals(listOf(5L, 6L), MraQueue.next(listOf(crn, doc(6)), mapOf("S-T1-1" to "refused"), "E1").map { it.counter })
        assertEquals(emptyList<Long>(), MraQueue.next(listOf(crn, doc(6)), mapOf("S-T1-1" to "check"), "E1").map { it.counter })
        // another till's sale: that till sends it
        assertEquals(listOf(5L, 6L), MraQueue.next(listOf(crn, doc(6)), emptyMap(), "E1").map { it.counter })
    }

    @Test fun anInvoiceOfAnotherEbsIsNotSentUnderThisOne() =
        assertEquals(listOf(2L), MraQueue.next(listOf(doc(1, ebs = "OLD"), doc(2)), emptyMap(), "E1").map { it.counter })

    @Test fun anAnswerForEachInvoice() {
        val r = MraQueue.read(MraHttp.Out.Answered(200, """{"status":"HAS_ERROR","responseId":"R1","fiscalisedInvoices":[
            {"invoiceIdentifier":"S-T1-1","irn":"I1","qrCode":"Q1","status":"SUCCESS"},
            {"invoiceIdentifier":"S-T1-2","status":"ERROR","errorMessages":[{"code":"ERR0600","description":"bad"}]}]}"""))
        r as MraQueue.Answered
        assertEquals("fiscalised", MraQueue.status(r.each.getValue("S-T1-1")))
        assertEquals("refused", MraQueue.status(r.each.getValue("S-T1-2")))
        assertEquals(listOf("ERR0600: bad"), r.each.getValue("S-T1-2").errors)
        assertEquals("R1", r.responseId)
    }

    // every answer says whether the MRA counted it: TEST (sandbox, Test Drive) or LIVE
    @Test fun theAnswerSaysTestOrLive() {
        val r = MraQueue.read(MraHttp.Out.Answered(200, """{"status":"SUCCESS","environment":"TEST","fiscalisedInvoices":[{"invoiceIdentifier":"S-T1-1","status":"SUCCESS"}]}"""))
        assertEquals("TEST", (r as MraQueue.Answered).environment)
        assertEquals(null, (MraQueue.read(MraHttp.Out.Answered(200, """{"status":"SUCCESS","fiscalisedInvoices":[{"invoiceIdentifier":"S-T1-1","status":"SUCCESS"}]}""")) as MraQueue.Answered).environment)
    }

    // ERR0020 (seen in the sandbox): the MRA saw none of them
    @Test fun aRequestRefusedWhole() {
        val r = MraQueue.read(MraHttp.Out.Answered(400, """{"status":"ERROR","errorMessages":[{"code":"ERR0020","description":"Missing request headers"}]}"""))
        assertEquals(MraQueue.RefusedWhole(listOf("ERR0020: Missing request headers"), false), r)
        assertTrue((MraQueue.read(MraHttp.Out.Answered(401, """{"status":"ERROR","errorMessages":[{"code":"ERR0050","description":"Token sent is not valid"}]}""")) as MraQueue.RefusedWhole).token)
        assertTrue((MraQueue.read(MraHttp.Out.Answered(401, "Unauthorized")) as MraQueue.RefusedWhole).token)
    }

    // no answer at all after the request went: it may have been fiscalised
    @Test fun noAnswerThatSaysWhatBecameOfIt() {
        assertEquals(MraQueue.NoAnswer, MraQueue.read(MraHttp.Out.NoAnswer("SocketTimeoutException")))
        assertEquals(MraQueue.NotReached, MraQueue.read(MraHttp.Out.NotReached("UnknownHostException")))
    }

    // An error page in the MRA's place (its gateway during an outage): the
    // invoices were not taken, and go again on their own, never left for a
    // manager to send one by one (the owner, 2026-10-23).
    @Test fun anErrorPageDuringAnOutageIsSentAgainOnItsOwn() {
        assertEquals(MraQueue.NotReached, MraQueue.read(MraHttp.Out.Answered(502, "<html>Bad gateway</html>")))
        assertEquals(MraQueue.NotReached, MraQueue.read(MraHttp.Out.Answered(503, "<html><body>Service Unavailable</body></html>")))
        assertEquals(MraQueue.NotReached, MraQueue.read(MraHttp.Out.Answered(504, "")))
        // the MRA's own error, as JSON, is still a refusal of the request with its reasons
        assertEquals(
            MraQueue.RefusedWhole(listOf("ERR0023: An internal server has occurred"), false),
            MraQueue.read(MraHttp.Out.Answered(500, """{"status":"ERROR","errorMessages":[{"code":"ERR0023","description":"An internal server has occurred"}]}""")),
        )
    }

    // MraDao.sending and notSent, as their SQL says: once unanswered is unsure (sent once more), twice is check
    @Test fun aRestartInTheMiddleOfASend() {
        fun sending(e: MraInvoiceEntity) = e.copy(unanswered = e.unanswered + 1, status = if (e.unanswered + 1 >= 2) "check" else "unsure")
        fun notSent(e: MraInvoiceEntity) = e.copy(unanswered = maxOf(e.unanswered - 1, 0), status = if (e.unanswered - 1 <= 0) "waiting" else "unsure")
        val first = sending(doc(1))
        assertEquals("unsure", first.status)
        // the app was killed: no outcome. The next drain takes it again, as unsure
        assertEquals(listOf(1L), MraQueue.next(listOf(first), emptyMap(), "E1").map { it.counter })
        val second = sending(first)
        assertEquals("check", second.status)
        // and then it is not sent again until a manager says so
        assertEquals(emptyList<Long>(), MraQueue.next(listOf(second).filter { it.status in setOf("waiting", "unsure") }, emptyMap(), "E1").map { it.counter })
        // a request that never reached the MRA does not use up its one more
        assertEquals("waiting", notSent(first).status)
        assertEquals("unsure", notSent(second).status)
    }
}
