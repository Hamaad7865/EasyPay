package com.restopos.core.sync

// Delete all transactions in the back office (server 0155) deletes every
// receipt, order and day on the server and writes when into the settings
// (`cleared`). A pull brings rows that changed, never rows that went, so the
// till goes by that mark: once for each, it empties what it rang up and pulls
// again from nothing, and what the server still has comes back (PullWorker).
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
}
