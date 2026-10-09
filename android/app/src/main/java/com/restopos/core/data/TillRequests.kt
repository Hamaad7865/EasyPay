package com.restopos.core.data

import com.restopos.core.database.TillDatabase
import com.restopos.core.database.TillRequestEntity
import com.restopos.core.network.ApiClient
import com.restopos.core.sync.SessionStore
import javax.inject.Inject
import javax.inject.Singleton

// What the back office asked of this till (server 0091), carried out after a
// pull has brought it: close the day, or write down cash taken out. Each
// request of this till that still waits and that it has not acted on is
// decided (RequestRules) and done or refused (CashOps), oldest first, once.
// One that fails here is left for the next sync; it is never in the way of
// the sync itself.
@Singleton
class TillRequests @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val cash: CashOps,
    private val api: ApiClient,
) {
    suspend fun run() {
        val device = session.deviceId() ?: return
        for (r in db.ops().waitingRequests(device)) runCatching { carryOut(r, device) }
    }

    private suspend fun carryOut(r: TillRequestEntity, device: String) {
        val open = db.staff().openShift(device)
        val closing = r.kind == "close_day"
        val decided = RequestRules.decide(
            r.kind, r.shift_id, open?.id, r.counted_cash, r.amount, r.reason,
            unpaid = if (closing) cash.unpaidNow() else null,
            usedSince = closing && open != null && cash.usedSince(open, RequestRules.onTablet(r.requested_at, api.clockAhead.value)),
        )
        val by = cash.employeeName(r.requested_by)?.let { " by $it" } ?: ""
        when (decided) {
            is Asked.Close -> {
                cash.closeDayAsked(r, decided.counted)
                cash.say("The day was closed from the back office$by.")
            }
            is Asked.CashOut -> {
                cash.cashOutAsked(r, decided.amount, decided.reason)
                cash.say("Cash taken out was written down from the back office$by" + if (decided.reason.isBlank()) "." else ": ${decided.reason}.")
            }
            is Asked.Refuse -> cash.refuseAsked(r, decided.why)
        }
    }
}
