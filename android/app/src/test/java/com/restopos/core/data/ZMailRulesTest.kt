package com.restopos.core.data

import com.restopos.core.data.ZMailRules.Answer
import com.restopos.core.print.CashSlipDoc
import com.restopos.core.print.DocAmount
import com.restopos.core.print.DocTax
import com.restopos.core.print.Docs
import com.restopos.core.print.Paper
import com.restopos.core.print.Shop
import com.restopos.core.print.ZDoc
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ZMailRulesTest {
    private val now = 1_790_000_000_000L
    private var made = 0
    private val newKey = { "k${++made}".padEnd(64, '0') }
    private fun on(to: String = "owner@example.mu") = ZMailRules.saved(ZMailSetting(), true, to, now, newKey)

    @Test
    fun anAddressIsTakenAsTheMailServiceTakesIt() {
        assertEquals("owner@example.mu", ZMailRules.address("  Owner@Example.MU "))
        assertEquals("a.b+z@mail.co.uk", ZMailRules.address("a.b+z@mail.co.uk"))
        for (bad in listOf("", "owner", "owner@", "@example.mu", "owner@example", "own er@x.mu", "a@b.c", "<a@b.mu>", "a..b@x.mu", ".a@x.mu", "a@-x.mu", "a@x.mu,b@y.mu")) {
            assertNull(bad, ZMailRules.address(bad))
        }
    }

    @Test
    fun theKeyIsSixtyFourSmallHexadecimalCharacters() {
        val k = ZMailRules.key(ByteArray(32) { (it * 37 - 128).toByte() })
        assertEquals(64, k.length)
        assertTrue(k.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun switchedOnItHasAKeyAndAsksAndMailsWhatClosesFromNowOn() {
        val s = on()
        assertTrue(s.on)
        assertEquals(64, s.key.length)
        assertEquals(ZMailRules.ASK, s.state)
        assertEquals(now, s.after)
        assertTrue(s.forget.isEmpty())
    }

    @Test
    fun theSameAddressSavedAgainChangesNothing() {
        val s = on().copy(state = ZMailRules.YES, after = now + 5, sentNo = 4)
        val again = ZMailRules.saved(s, true, " OWNER@example.mu", now + 99, newKey)
        assertEquals(s.key, again.key)
        assertEquals(ZMailRules.YES, again.state)
        assertEquals(now + 5, again.after)
        assertEquals(4, again.sentNo)
    }

    @Test
    fun anotherAddressHasItsOwnKeyTakesOverWhatWaitsAndTheOldOneIsForgotten() {
        val s = on().copy(state = ZMailRules.YES, after = now + 5)
        val other = ZMailRules.saved(s, true, "manager@example.mu", now + 99, newKey)
        assertEquals("manager@example.mu", other.to)
        assertFalse(other.key == s.key)
        assertEquals(ZMailRules.ASK, other.state)
        // the closings not yet mailed go to the new address
        assertEquals(now + 5, other.after)
        assertEquals(listOf(ZMailForget("owner@example.mu", s.key)), other.forget)
    }

    @Test
    fun switchedOffNothingMoreGoesTheAddressStaysToShowAndTheServiceIsToForgetIt() {
        val s = on().copy(state = ZMailRules.YES)
        val off = ZMailRules.saved(s, false, "owner@example.mu", now + 1, newKey)
        assertFalse(off.on)
        assertEquals("owner@example.mu", off.to)
        assertEquals("", off.key)
        assertEquals(listOf(ZMailForget("owner@example.mu", s.key)), off.forget)
        // switched on again later: a new key, and only what closes from then on
        val back = ZMailRules.saved(off, true, "owner@example.mu", now + 500, newKey)
        assertFalse(back.key == s.key)
        assertEquals(now + 500, back.after)
        // never switched on: there is nothing for the service to forget
        assertTrue(ZMailRules.saved(ZMailSetting(), false, "", now, newKey).forget.isEmpty())
    }

    @Test
    fun itIsKeptAsJsonAndReadBackAndWhatCannotBeReadIsOff() {
        val s = on().copy(state = ZMailRules.WAITING, asked = now, forget = listOf(ZMailForget("a@b.mu", "x".repeat(64))))
        assertEquals(s, ZMailRules.read(ZMailRules.write(s)))
        assertEquals(ZMailSetting(), ZMailRules.read(null))
        assertEquals(ZMailSetting(), ZMailRules.read("{not json"))
        // a field a newer build added is passed over
        assertTrue(ZMailRules.read("""{"on":true,"to":"a@b.mu","later":"a field of a newer build"}""").on)
    }

    @Test
    fun whatTheServiceSaysToAnAsk() {
        val s = on()
        assertEquals(ZMailRules.WAITING, ZMailRules.asked(s, Answer(200, "waiting"), now).state)
        assertEquals(now, ZMailRules.asked(s, Answer(200, "waiting"), now).asked)
        // the address had confirmed for this key already
        assertEquals(ZMailRules.YES, ZMailRules.asked(s, Answer(200, "yes"), now).state)
        // three asks a day at most: still to ask, tomorrow, and why
        val busy = ZMailRules.asked(s, Answer(429, "none", "too many emails to confirm today"), now)
        assertEquals(ZMailRules.ASK, busy.state)
        assertEquals("too many emails to confirm today", busy.said)
        assertEquals(ZMailRules.REFUSED, ZMailRules.asked(s, Answer(422, error = "this address bounced"), now).state)
        assertEquals(ZMailRules.REFUSED, ZMailRules.asked(s, Answer(400, error = "that is not an email address"), now).state)
        assertEquals(ZMailRules.ASK, ZMailRules.asked(s, Answer(503), now).state)
    }

    @Test
    fun whatTheServiceSaysOfAnAddressWaitingToConfirm() {
        val s = on().copy(state = ZMailRules.WAITING)
        assertEquals(ZMailRules.YES, ZMailRules.checked(s, Answer(200, "yes")).state)
        assertEquals(ZMailRules.WAITING, ZMailRules.checked(s, Answer(200, "waiting")).state)
        assertEquals(ZMailRules.EXPIRED, ZMailRules.checked(s, Answer(200, "none")).state)
        assertEquals(ZMailRules.WAITING, ZMailRules.checked(s, Answer(503)).state)
    }

    @Test
    fun aClosingMailedMovesTheMarkOnAndIsSaid() {
        val s = on().copy(state = ZMailRules.YES)
        val sent = ZMailRules.mailed(s, now + 1000, 12, now + 2000, Answer(200, "yes", sent = true))
        assertEquals(now + 1000, sent.after)
        assertEquals(12, sent.sentNo)
        assertEquals(now + 2000, sent.sentAt)
        // an answer for an older closing never moves it back
        assertEquals(now + 1000, ZMailRules.mailed(sent, now + 10, 11, now, Answer(200, "yes", sent = true)).after)
    }

    @Test
    fun aClosingTheServiceDidNotTakeLeavesTheMarkOrSaysWhy() {
        val s = on().copy(state = ZMailRules.YES)
        // the link at a report's foot was used
        assertEquals(ZMailRules.STOPPED, ZMailRules.mailed(s, now + 1, 1, now, Answer(403, "none")).state)
        assertEquals(ZMailRules.WAITING, ZMailRules.mailed(s, now + 1, 1, now, Answer(403, "waiting")).state)
        assertEquals(ZMailRules.REFUSED, ZMailRules.mailed(s, now + 1, 1, now, Answer(422, "yes", "this address bounced EasyPay's mail")).state)
        for (later in listOf(Answer(429, "yes", "too many"), Answer(409, "yes"), Answer(503, "yes"))) {
            val r = ZMailRules.mailed(s, now + 1, 1, now, later)
            assertEquals(ZMailRules.YES, r.state)
            assertEquals(s.after, r.after)
            assertTrue(ZMailRules.later(later))
        }
        // one the service could not read, and never will, is passed over
        assertEquals(now + 1, ZMailRules.mailed(s, now + 1, 1, now, Answer(400, error = "the report is too long")).after)
        assertTrue(ZMailRules.later(null))
        assertFalse(ZMailRules.later(Answer(200, "yes", sent = true)))
    }

    @Test
    fun aMonthIsTheOldestMailed() {
        val s = on().copy(after = 0)
        assertEquals(now - ZMailRules.OLDEST_MS, ZMailRules.from(s, now))
        assertEquals(now - 5, ZMailRules.from(s.copy(after = now - 5), now))
    }

    @Test
    fun anAnswerIsOnlyForTheSettingItWasAskedFor() {
        val s = on()
        assertTrue(ZMailRules.stillFor(s.copy(state = ZMailRules.WAITING), s))
        assertFalse(ZMailRules.stillFor(ZMailRules.saved(s, false, s.to, now, newKey), s))
        assertFalse(ZMailRules.stillFor(ZMailRules.saved(s, true, "other@example.mu", now, newKey), s))
    }

    @Test
    fun sendItAgainAsksOnceMore() {
        val s = on().copy(state = ZMailRules.EXPIRED)
        assertEquals(ZMailRules.ASK, ZMailRules.again(s).state)
        // switched off, there is nothing to ask
        assertEquals(ZMailRules.EXPIRED, ZMailRules.again(ZMailSetting(on = false, state = ZMailRules.EXPIRED)).state)
    }

    @Test
    fun whatSettingsSays() {
        val stamp = { _: Long -> "25 Oct 23:10" }
        val s = on()
        assertTrue(ZMailRules.words(s, 0, stamp).text.contains("goes to owner@example.mu as soon as the tablet is online"))
        val waiting = ZMailRules.words(s.copy(state = ZMailRules.WAITING, asked = now), 2, stamp)
        assertTrue(waiting.text.contains("press Confirm"))
        assertTrue(waiting.again)
        val yes = ZMailRules.words(s.copy(state = ZMailRules.YES, sentNo = 12, sentAt = now), 2, stamp)
        assertTrue(yes.text.contains("emailed to owner@example.mu"))
        assertTrue(yes.text.contains("no. 12, went at 25 Oct 23:10"))
        assertTrue(yes.text.contains("2 closings wait"))
        assertFalse(yes.again)
        assertTrue(ZMailRules.words(s.copy(state = ZMailRules.STOPPED), 0, stamp).text.contains("asked for no more"))
        assertTrue(ZMailRules.words(s.copy(state = ZMailRules.EXPIRED), 0, stamp).again)
        assertTrue(ZMailRules.words(s.copy(state = ZMailRules.REFUSED, said = "this address bounced EasyPay's mail"), 0, stamp).text.contains("bounced"))
    }

    // The Z as the mail service gets it: its paper's parts, in the shape it reads.
    // The service lays its report and PDF out from cloudflare/mail/test/z-parts.json,
    // so the till is held to that example: a change to the paper changes the file
    // (delete it and run this test to write it again), and the service's tests see it.
    @Test
    fun theDayClosingsPartsAreTheMailServicesExample() {
        val z = ZDoc(
            12, "Till 1", 1_792_800_000_000, 1_792_840_000_000, "Priya", 42, 1_865_000, 1, 25_000, 12_000, 243_261,
            listOf(DocAmount("Cash", 1_040_000, 30), DocAmount("Card", 800_000, 12)),
            listOf(DocAmount("Mains", 1_200_000, 40), DocAmount("Drinks", 665_000, 55)),
            listOf(DocTax("VAT", 1500, 243_261, true)),
            50_000, 30_000, listOf(CashSlipDoc("out", 30_000, "Gas", 1_792_820_000_000, "Priya", "Till 1")),
            "CT-T1-000101", "CT-T1-000142",
            openedAt = 1_792_800_000_000, openedBy = "Ben", float = 200_000, cashTaken = 1_040_000, expected = 1_260_000, counted = 1_255_000,
        )
        val shop = Shop("Chez Ravi", "Royal Road, Curepipe", "5 123 4567", "C12345678", "VAT27000000")
        // the paper writes its times on the tablet's clock: here, Mauritius's, wherever the test runs
        val was = java.util.TimeZone.getDefault()
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("Indian/Mauritius"))
        val parts = try { Docs.zParts(z, shop, Paper(48, 0, false), 2, detailed = true) } finally { java.util.TimeZone.setDefault(was) }
        // what the service reads: the title, the total in its size, a section's heading, the drawer's short
        assertTrue(parts.any { it.kind == "center" && it.bold && it.left == "DAY CLOSING (Z) No. 12" })
        assertTrue(parts.any { it.kind == "row" && it.left == "TOTAL" && it.right == "Rs 18,400.00" && it.bold && it.size == "tall" })
        assertTrue(parts.any { it.kind == "text" && it.bold && it.left == "BY PAYMENT METHOD" })
        assertTrue(parts.any { it.kind == "row" && it.left == "SHORT" && it.right == "-50.00" })
        assertTrue(parts.count { it.kind == "rule" } >= 5)
        // a row's own lines are not parts of their own
        assertFalse(parts.any { it.kind == "text" && it.left.startsWith("TOTAL") })
        val json = Json { prettyPrint = true }
        val made = json.encodeToString(JsonElement.serializer(), ZMailRules.partsJson(parts)) + "\n"
        val file = File("../../cloudflare/mail/test/z-parts.json")
        if (!file.exists()) file.writeText(made)
        assertEquals(file.readText().replace("\r\n", "\n"), made)
    }
}

