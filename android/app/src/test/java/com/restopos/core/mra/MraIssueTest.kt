package com.restopos.core.mra

import com.restopos.core.database.MraInvoiceEntity
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// What the next document of a till goes to the MRA as, or why the payment is refused.
class MraIssueTest {
    private val now = 1_761_040_000_000L
    private fun plan(
        mode: String = "live", ebs: String? = "EBS1", restored: Boolean = true, refund: Boolean = false, ofTraining: Boolean = false,
        counter: Long = 41, chain: String = "{}", last: Long? = now - 1000, clock: Long? = 0, refusal: String? = null,
    ) = MraIssue.plan(mode, ebs, restored, refund, ofTraining, "S1-T1-000123", counter, chain, last, clock, now, refusal)

    @Test fun offAndSettingUpSendNothing() {
        assertEquals(MraIssue.Skip, plan(mode = "off"))
        assertEquals(MraIssue.Skip, plan(mode = "setting_up"))
    }

    @Test fun liveSendsTheSaleAsSTDUnderItsReceiptNumber() {
        assertEquals(MraIssue.Issue("STD", 42, "S1-T1-000123", null), plan())
    }

    @Test fun aRefundGoesAsACreditNote() = assertEquals("CRN", (plan(refund = true) as MraIssue.Issue).type)

    @Test fun trainingSendsTRNUnderItsCounter() {
        assertEquals(MraIssue.Issue("TRN", 42, "TRN00000042", null), plan(mode = "training"))
        assertEquals("TRN", (plan(mode = "training", refund = true) as MraIssue.Issue).type)
    }

    @Test fun aRefundOfATrainingSaleIsATrainingDocument() = assertEquals("TRN", (plan(refund = true, ofTraining = true) as MraIssue.Issue).type)

    @Test fun theNextOfATypeHashesTheLastOfThatType() {
        val a = Chained("20261021 10:00:00", "50.00", "C1", "S1-T1-000122")
        val chain = MraChain.with("{}", "STD", 41, a)
        assertEquals(a, (plan(chain = chain) as MraIssue.Issue).previous)
        assertEquals(null, (plan(chain = chain, refund = true) as MraIssue.Issue).previous)
    }

    @Test fun aLiveTillWithNoEbsMraIdTakesNoPayment_aTrainingOneSendsNothing() {
        assertTrue(plan(ebs = null) is MraIssue.Refuse)
        assertTrue(plan(ebs = " ") is MraIssue.Refuse)
        assertEquals(MraIssue.Skip, plan(mode = "training", ebs = null))
    }

    @Test fun aTillSetUpAgainWaitsForItsNumbers() = assertTrue((plan(restored = false) as MraIssue.Refuse).why.contains("sync"))

    // design section 7: off by more than 5 minutes, no payment; not known (offline, just started), the sale goes on
    @Test fun theClock() {
        assertTrue(plan(clock = 5 * 60_000L + 1) is MraIssue.Refuse)
        assertTrue(plan(clock = -(5 * 60_000L + 1)) is MraIssue.Refuse)
        assertTrue(plan(clock = 5 * 60_000L) is MraIssue.Issue)
        assertTrue(plan(clock = null) is MraIssue.Issue)
        assertTrue((plan(last = now + 1) as MraIssue.Refuse).why.contains("earlier than its last invoice"))
    }

    @Test fun aSaleTheMraCannotTakeIsRefusedWithItsReason() =
        assertEquals(MraIssue.Refuse("Wine has two taxes"), plan(refusal = "Wine has two taxes"))

    @Test fun whatTheServerIsToldHoldsNoSecretAndTheInvoiceAsSent() {
        val e = MraInvoiceEntity("r1", "t1", "s1", "d1", "EBS1", "r1", "STD", 42, "S1-T1-000123", null, "0", """{"a":"1"}""", now,
            status = "fiscalised", irn = "IRN", qr = "iVBOR", errors = "[]", warnings = """["W1: x"]""", answered_at = now + 300)
        val r = MraIssue.record(e)
        assertEquals("""{"a":"1"}""", r["invoice"]!!.jsonPrimitive.content)
        assertEquals("42", r["counter"]!!.jsonPrimitive.content)
        assertEquals("W1: x", r["warnings"]!!.jsonArray[0].jsonPrimitive.content)
        assertFalse(r.containsKey("ref_identifier"))
        assertEquals(setOf("id", "store_id", "device_id", "ebs_id", "receipt_id", "type", "counter", "identifier", "previous_hash", "invoice", "issued_at", "status", "irn", "qr", "errors", "warnings", "answered_at"), r.keys)
    }

    @Test fun aPhoneNumberAsTheMraTakesIt() = assertEquals("+2302076000", MraIssue.phone("+230 207 6000"))
}
