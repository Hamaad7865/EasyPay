package com.restopos.core.sync

// Delete all transactions in the back office (server 0155) deletes every
// receipt, order and day on the server and writes when into the settings
// (`cleared`). A pull brings rows that changed, never rows that went, so the
// till goes by that mark: once for each, it empties what it rang up and pulls
// again from nothing, and what the server still has comes back (PullWorker).
// Go live of a business in the cloud (server 0157) writes the same mark, and
// when the business went live (`live`, ms).
internal object OfficeClear {
    enum class Step { NONE, NOTE, WAIT, CLEAR }

    // cleared: the settings' mark; applied: the one this till last acted on.
    // fromStart: this pull began at nothing, so the till holds what the server
    // has now. pending/refused: changes still to go up, or refused.
    fun step(cleared: String?, applied: String?, alone: Boolean, fromStart: Boolean, pending: Long, refused: Long): Step = when {
        cleared == null || cleared == applied -> Step.NONE
        // a tablet that works on its own: its sales are on no server
        alone -> Step.NONE
        fromStart -> Step.NOTE
        // a sale emptied before it went up would be on no list; one refused is looked at first
        pending > 0 || refused > 0 -> Step.WAIT
        else -> Step.CLEAR
    }

    // Before the step, on a mark not acted on yet, of a business that went live
    // from being set up: what was rung up here before then and is still in the
    // queue, waiting or refused, was trying. It goes, as at an offline tablet's
    // Go live (GoLiveRules.RUNG_UP); the server would drop it anyway. What was
    // set up goes up as ever, and so does a sale made since. The answer is the
    // moment before which it goes, or null for nothing. `live` is the server's
    // clock and the queue the tablet's: clockAhead (ApiClient, null when not
    // heard yet) moves it onto the tablet's.
    fun dropBefore(live: Long?, cleared: String?, applied: String?, alone: Boolean, clockAhead: Long? = null): Long? =
        if (live == null || alone || cleared == null || cleared == applied) null else live + (clockAhead ?: 0)
}
