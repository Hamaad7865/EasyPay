package com.restopos.core.data

import com.restopos.core.database.TillDatabase
import com.restopos.core.database.TillRequestEntity
import com.restopos.core.network.ApiClient
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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
    // What the till did because it was asked, for whoever is at it, or next
    // comes to it, to be told once: it is kept until the screen has said it.
    private val _said = MutableStateFlow<String?>(null)
    val said: StateFlow<String?> = _said
    fun heard() { _said.value = null }

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
        // done as of when it was asked: an idle till may only hear of it hours later
        val at = RequestRules.moment(r.requested_at, api.clockAhead.value, open?.opened_at ?: 0, System.currentTimeMillis())
        val by = cash.employeeName(r.requested_by)?.let { " by $it" } ?: ""
        when (decided) {
            is Asked.Close -> {
                cash.closeDayAsked(r, decided.counted, at)
                _said.value = "The day was closed from the back office$by."
            }
            is Asked.CashOut -> {
                cash.cashOutAsked(r, decided.amount, decided.reason, at)
                _said.value = "Cash taken out was written down from the back office$by" + if (decided.reason.isBlank()) "." else ": ${decided.reason}."
            }
            is Asked.Refuse -> cash.refuseAsked(r, decided.why)
        }
    }
}
