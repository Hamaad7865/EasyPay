package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

// When a till closes a day nobody closed, and as of what moment
// (docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md).
class AutoCloseRulesTest {
    private val zone = ZoneId.of("Indian/Mauritius")
    private fun t(day: Int, h: Int, m: Int = 0): Long = LocalDate.of(2026, 1, day).atTime(h, m).atZone(zone).toInstant().toEpochMilli()
    private val midnight = LocalTime.MIDNIGHT
    private val opened = t(1, 9)
    private fun decide(lastMoney: Long?, from: Long, to: Long, at: LocalTime = midnight, dayFrom: Long = opened) =
        AutoCloseRules.decide(dayFrom, at, zone, lastMoney, from, to)

    @Test fun the_cut_off_is_the_first_set_time_after_the_day_opened() {
        assertEquals(t(2, 0), AutoCloseRules.cutoff(opened, midnight, zone))
        assertEquals(t(2, 5), AutoCloseRules.cutoff(opened, LocalTime.of(5, 0), zone))
        // a day opened after five in the morning closes at five the next morning
        assertEquals(t(2, 5), AutoCloseRules.cutoff(t(1, 6), LocalTime.of(5, 0), zone))
        // and one opened at four closes at five the same morning
        assertEquals(t(1, 5), AutoCloseRules.cutoff(t(1, 4), LocalTime.of(5, 0), zone))
    }

    @Test fun before_the_cut_off_nothing_happens() {
        assertNull(decide(t(1, 22), t(1, 22), t(1, 23, 50)))
    }

    @Test fun a_till_left_alone_overnight_is_closed_as_of_the_cut_off() {
        // last sale at 22:00, last touch 23:10, the app opened again at 08:00
        assertEquals(t(2, 0), decide(t(1, 22), t(1, 23, 10), t(2, 8)))
        // or the till stayed on and the minute's look came at 00:30
        assertEquals(t(2, 0), decide(t(1, 22), t(1, 23, 10), t(2, 0, 30)))
    }

    @Test fun not_quiet_for_thirty_minutes_after_the_cut_off_is_not_closed_yet() {
        assertNull(decide(t(1, 22), t(1, 23, 10), t(2, 0, 29)))
        // touched at 00:10: quiet only since then
        assertNull(decide(t(1, 22), t(2, 0, 10), t(2, 0, 39)))
    }

    @Test fun a_bar_still_selling_after_midnight_closes_thirty_minutes_after_its_last_sale() {
        // last sale 01:35, last touch 01:40, looked at 02:10
        assertEquals(t(2, 2, 5), decide(t(2, 1, 35), t(2, 1, 40), t(2, 2, 10)))
        // the stretch begins no earlier than the sale: the same when the last touch was the sale
        assertEquals(t(2, 2, 5), decide(t(2, 1, 35), t(2, 1, 35), t(2, 2, 10)))
    }

    @Test fun drinks_added_after_midnight_with_no_payment_wait_then_close_as_of_the_cut_off() {
        // tabs open, drinks added until 01:00 (touches), nothing paid since 23:20
        assertNull(decide(t(1, 23, 20), t(2, 1), t(2, 1, 20)))
        assertEquals(t(2, 0), decide(t(1, 23, 20), t(2, 1), t(2, 1, 30)))
    }

    @Test fun a_till_off_for_three_days_gets_one_closing_as_of_the_first_cut_off() {
        assertEquals(t(2, 0), decide(t(1, 20), t(1, 21), t(4, 9)))
    }

    @Test fun a_day_opened_at_ten_to_midnight_follows_the_same_rules() {
        assertEquals(t(2, 0), decide(null, t(1, 23, 50), t(2, 0, 30), dayFrom = t(1, 23, 50)))
    }

    @Test fun the_set_time_is_read_as_hours_and_minutes_only() {
        assertEquals(LocalTime.of(5, 0), AutoCloseRules.parse("05:00"))
        assertEquals(LocalTime.MIDNIGHT, AutoCloseRules.parse("00:00"))
        assertEquals(LocalTime.of(23, 59), AutoCloseRules.parse("23:59"))
        listOf(null, "", "5:00", "24:00", "00:60", "midnight", "05:00:00").forEach { assertNull(it, AutoCloseRules.parse(it)) }
        assertEquals("05:00", AutoCloseRules.format(LocalTime.of(5, 0)))
    }

    @Test fun the_settings_carry_it_or_say_it_is_off() {
        assertEquals(LocalTime.of(5, 0), PosSettings.parse("""{"autoClose":"05:00"}""").autoClose)
        assertNull(PosSettings.parse("""{"autoClose":null}""").autoClose)
        assertNull(PosSettings.parse("""{}""").autoClose)
        assertNull(PosSettings.parse("""{"autoClose":"25:00"}""").autoClose)
    }

    @Test fun the_next_person_is_told_what_happened() {
        assertEquals(
            "The day was closed automatically (2 Jan, 00:00, no. 42). The drawer was not counted. 3 orders still unpaid were carried over.",
            AutoCloseRules.notice(42, t(2, 0), 3, zone),
        )
        assertEquals("The day was closed automatically (2 Jan, 00:00, no. 7). The drawer was not counted.", AutoCloseRules.notice(7, t(2, 0), 0, zone))
        assertEquals(
            "The day was closed automatically (2 Jan, 00:00, no. 7). 1 order still unpaid was carried over.",
            AutoCloseRules.notice(7, t(2, 0), 1, zone, counted = false),
        )
    }
}
