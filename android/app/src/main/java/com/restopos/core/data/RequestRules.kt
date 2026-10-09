package com.restopos.core.data

// What a till does with something the back office asked of it (server 0091).
sealed interface Asked {
    // close the day: with this count, or at what the till expects when there is none
    data class Close(val counted: Long?) : Asked
    data class CashOut(val amount: Long, val reason: String) : Asked
    // not done, and why, in words the owner reads in the back office
    data class Refuse(val why: String) : Asked
}

// The back office closes nothing and moves no cash: a till owns its day and
// works out its drawer from what it holds itself. So the back office asks,
// and the till decides here, the next time it syncs: it carries the request
// out with its own figures, or refuses and says why.
object RequestRules {
    const val NOT_THAT_DAY = "That day is no longer open on the till."
    const val USED_SINCE = "The till was used after this was asked. Count the drawer and ask again."
    const val NO_AMOUNT = "No amount was asked for."
    const val NOT_KNOWN = "This till's build does not know how to do that. Update the till."

    // The till hears the server's clock to the second, so a sale within a few
    // seconds of the request is not taken for one made after it.
    const val SLACK_MS = 5_000L

    // When something was asked, by the tablet's own clock: the request carries
    // the server's time, the till's sales the tablet's. `clockAhead` is how
    // far the tablet's clock is ahead of the server's, as the till last heard
    // it (null: not heard yet, and the tablet's clock is taken as right).
    fun onTablet(requestedAt: Long, clockAhead: Long?): Long = requestedAt + (clockAhead ?: 0) + SLACK_MS

    // The moment a request is carried out as of: when it was asked, by the
    // tablet's clock, and not the moment the till got round to it. A till
    // nobody is at stops syncing (Quiet) and hears of the request at its next
    // touch, which for a day left open overnight is the next morning: the
    // day is still closed as of last night. It is the same moment "used
    // since" looks from, so nothing falls between the two; never before the
    // day opened, and never later than now.
    fun moment(requestedAt: Long, clockAhead: Long?, openedAt: Long, now: Long): Long =
        minOf(now, maxOf(openedAt, onTablet(requestedAt, clockAhead)))

    // `askedShift` is the day the request names, `openShift` the one open on
    // this till now. `unpaid` is why the day cannot be closed yet, in the
    // till's own words, or null. `usedSince`: a sale, a refund, cash moved or
    // a count was written down on this till after the request was made.
    fun decide(
        kind: String, askedShift: String, openShift: String?, counted: Long?, amount: Long?, reason: String?, unpaid: String?, usedSince: Boolean,
    ): Asked {
        if (kind != "close_day" && kind != "cash_out") return Asked.Refuse(NOT_KNOWN)
        if (openShift == null || openShift != askedShift) return Asked.Refuse(NOT_THAT_DAY)
        if (kind == "cash_out") return if (amount == null || amount <= 0) Asked.Refuse(NO_AMOUNT) else Asked.CashOut(amount, reason.orEmpty())
        if (unpaid != null) return Asked.Refuse(unpaid)
        // whoever asked counted, or looked at what the till expected, before this
        if (usedSince) return Asked.Refuse(USED_SINCE)
        return Asked.Close(counted)
    }
}
