package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

// What a till does with something the back office asked of it (server 0091):
// close its day, or write down cash taken out. The till owns its day, so it
// decides: it carries the request out with its own figures, or refuses and
// says why, and the back office shows the answer.
class RequestRulesTest {
    private val day = "shift-1"
    private fun close(open: String? = day, counted: Long? = null, unpaid: String? = null, usedSince: Boolean = false) =
        RequestRules.decide("close_day", day, open, counted, null, null, unpaid, usedSince)
    private fun cashOut(open: String? = day, amount: Long? = 7000, reason: String? = "Ice", unpaid: String? = null, usedSince: Boolean = false) =
        RequestRules.decide("cash_out", day, open, null, amount, reason, unpaid, usedSince)

    @Test fun the_day_asked_about_is_closed_with_the_count_that_was_typed() {
        assertEquals(Asked.Close(117000), close(counted = 117000))
    }

    @Test fun with_no_count_it_is_closed_at_what_the_till_expects() {
        // the till puts its own expected figure where the count would be
        assertEquals(Asked.Close(null), close())
    }

    @Test fun a_day_that_is_no_longer_the_one_open_is_not_closed() {
        // closed on the tablet meanwhile, or closed and a new one opened: the new day is not this request's
        assertEquals(Asked.Refuse(RequestRules.NOT_THAT_DAY), close(open = null))
        assertEquals(Asked.Refuse(RequestRules.NOT_THAT_DAY), close(open = "shift-2"))
    }

    @Test fun an_unpaid_order_holds_the_day_open_in_the_tills_own_words() {
        val words = "2 orders are still unpaid. Take payment for them, or void them, before closing the day."
        assertEquals(Asked.Refuse(words), close(unpaid = words))
    }

    @Test fun a_till_used_after_the_request_was_made_is_not_closed_on_a_stale_count() {
        assertEquals(Asked.Refuse(RequestRules.USED_SINCE), close(counted = 117000, usedSince = true))
        // nor at "what the till expects": whoever asked was looking at figures from before
        assertEquals(Asked.Refuse(RequestRules.USED_SINCE), close(usedSince = true))
    }

    @Test fun the_day_being_another_one_is_said_before_anything_else() {
        assertEquals(Asked.Refuse(RequestRules.NOT_THAT_DAY), close(open = "shift-2", unpaid = "1 order is still unpaid.", usedSince = true))
    }

    @Test fun cash_taken_out_is_written_down_in_the_day_asked_about() {
        assertEquals(Asked.CashOut(7000, "Ice"), cashOut())
        // an order on a table or a sale since does not stop cash being written down
        assertEquals(Asked.CashOut(7000, "Ice"), cashOut(unpaid = "1 order is still unpaid.", usedSince = true))
        assertEquals(Asked.CashOut(7000, ""), cashOut(reason = null))
    }

    @Test fun but_not_in_another_day_and_not_without_an_amount() {
        assertEquals(Asked.Refuse(RequestRules.NOT_THAT_DAY), cashOut(open = null))
        assertEquals(Asked.Refuse(RequestRules.NOT_THAT_DAY), cashOut(open = "shift-2"))
        assertEquals(Asked.Refuse(RequestRules.NO_AMOUNT), cashOut(amount = null))
        assertEquals(Asked.Refuse(RequestRules.NO_AMOUNT), cashOut(amount = 0))
    }

    @Test fun something_this_build_was_never_taught_is_refused_and_says_to_update() {
        assertEquals(Asked.Refuse(RequestRules.NOT_KNOWN), RequestRules.decide("open_day", day, day, null, null, null, null, false))
    }

    @Test fun the_moment_it_was_asked_is_read_by_the_tablets_own_clock() {
        // the server stamped the request; the till's sales carry the tablet's time. A tablet a
        // minute ahead of the server has its sales a minute "later" than they were.
        val asked = 1_800_000_000_000L
        assertEquals(asked + 60_000 + RequestRules.SLACK_MS, RequestRules.onTablet(asked, 60_000))
        assertEquals(asked - 90_000 + RequestRules.SLACK_MS, RequestRules.onTablet(asked, -90_000))
        // a till that has not heard the server's clock yet takes its own as right
        assertEquals(asked + RequestRules.SLACK_MS, RequestRules.onTablet(asked, null))
    }

    @Test fun a_till_that_hears_of_it_the_next_morning_closes_the_day_as_of_last_night() {
        // asked at ten at night with nobody at the till; it syncs at eight the next morning
        val asked = 1_800_000_000_000L
        val opened = asked - 12 * 3_600_000L
        val morning = asked + 10 * 3_600_000L
        assertEquals(asked + RequestRules.SLACK_MS, RequestRules.moment(asked, 0, opened, morning))
        // the same moment "used since" looks from, whatever the tablet's clock is set to
        assertEquals(RequestRules.onTablet(asked, 60_000), RequestRules.moment(asked, 60_000, opened, morning))
    }

    @Test fun never_later_than_now_and_never_before_the_day_opened() {
        val asked = 1_800_000_000_000L
        // a till in use carries it out within seconds: its clock has not reached the slack yet
        assertEquals(asked + 1_000, RequestRules.moment(asked, 0, asked - 3_600_000L, now = asked + 1_000))
        // a tablet whose clock is far behind the server's
        assertEquals(asked - 60_000, RequestRules.moment(asked, -3_600_000L, openedAt = asked - 60_000, now = asked))
    }
}
