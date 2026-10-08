package com.restopos.core.sync

import org.junit.Assert.assertEquals
import org.junit.Test

// How far a pull goes: page after page until the server has no more. A pull
// that stops part of the way leaves a till with part of what it should hold
// (a new till in a busy restaurant, or one that was off for days) until some
// later sync carries on.
class PullPagingTest {
    // a server holding `rows` rows that hands out `per` of them to a page
    private fun server(rows: Long, per: Long): (Long) -> PullPaging.Page = { cursor ->
        val next = minOf(cursor + per, rows)
        PullPaging.Page(next, more = next < rows)
    }

    @Test fun a_pull_goes_on_until_the_server_has_no_more() {
        // a month of a busy restaurant's bills, for a till that is new: 60,000 rows, 200 to a page
        val asked = ArrayList<Long>()
        val pages = PullPaging.read(0) { cursor -> asked.add(cursor); server(60_000, 200)(cursor) }
        assertEquals(300, pages)
        assertEquals(0L, asked.first())
        assertEquals(59_800L, asked.last())
    }

    @Test fun it_carries_on_from_where_the_last_pull_stopped() {
        val asked = ArrayList<Long>()
        val pages = PullPaging.read(59_000) { cursor -> asked.add(cursor); server(60_000, 200)(cursor) }
        assertEquals(5, pages)
        assertEquals(listOf(59_000L, 59_200L, 59_400L, 59_600L, 59_800L), asked)
    }

    @Test fun one_page_is_all_when_nothing_is_new() {
        var asked = 0
        val pages = PullPaging.read(1_234) { cursor -> asked++; PullPaging.Page(cursor, more = false) }
        assertEquals(1, pages)
        assertEquals(1, asked)
    }

    @Test fun a_page_that_does_not_move_the_cursor_ends_the_pull() {
        // "there is more" with nothing new to give would be asked for again for ever
        var asked = 0
        val pages = PullPaging.read(500) { cursor -> asked++; PullPaging.Page(cursor, more = true) }
        assertEquals(1, pages)
        assertEquals(1, asked)
    }

    @Test fun a_rewritten_history_is_read_again_from_the_start() {
        // the page read at 4,000 found the server's tables rewritten: the next one asks from nothing
        val asked = ArrayList<Long>()
        var rewritten = true
        val pages = PullPaging.read(4_000) { cursor ->
            asked.add(cursor)
            if (rewritten) { rewritten = false; PullPaging.Page(0, more = true, restart = true) } else server(600, 200)(cursor)
        }
        assertEquals(listOf(4_000L, 0L, 200L, 400L), asked)
        assertEquals(4, pages)
    }

    @Test fun a_server_that_never_ends_is_left_at_the_guard() {
        var asked = 0
        val pages = PullPaging.read(0) { cursor -> asked++; PullPaging.Page(cursor + 1, more = true) }
        assertEquals(PullPaging.MOST_PAGES, pages)
        assertEquals(PullPaging.MOST_PAGES, asked)
    }
}
