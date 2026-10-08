package com.restopos.core.sync

// How far a pull goes (spec 5.5): page after page until the server says there
// is no more. It used to stop after fifty pages whatever the server said. A
// till with more than that to fetch (a new till in a restaurant that has
// traded for a month, or one that was switched off for days) was left with
// part of what it should hold, and with none of what had changed lately,
// until a later sync carried on: up to a quarter of an hour each time.
//
// Every page is written to the tablet with its cursor before the next is
// asked for (PullApplier), so a pull that is cut short, by the network or by
// Android stopping the work, loses nothing: the next one carries on from
// there. No Android here, so the unit tests can ask it.
internal object PullPaging {
    // A guard, not a limit anyone should meet: a server that kept saying
    // "there is more" would otherwise be asked for ever. At 200 rows of each
    // table to a page it is a million rows of each.
    const val MOST_PAGES = 5000

    // What reading one page came to: where the next one starts, and whether
    // the server has more. restart: the server's tables were rewritten and the
    // tablet's copy was emptied, so the next page is asked for from nothing.
    class Page(val next: Long, val more: Boolean, val restart: Boolean = false)

    // Reads pages from `start` on. Returns how many were read. A page that
    // says there is more without moving the cursor on ends the pull: asked
    // for again it would say the same.
    inline fun read(start: Long, page: (cursor: Long) -> Page): Int {
        var cursor = start
        var pages = 0
        while (pages < MOST_PAGES) {
            pages++
            val p = page(cursor)
            if (p.restart) { cursor = 0; continue }
            val moved = p.next > cursor
            cursor = p.next
            if (!p.more || !moved) break
        }
        return pages
    }
}
