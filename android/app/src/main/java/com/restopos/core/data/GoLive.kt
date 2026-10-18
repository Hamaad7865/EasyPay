package com.restopos.core.data

import androidx.room.withTransaction
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.Printing
import com.restopos.core.sync.SessionStore
import javax.inject.Inject
import javax.inject.Singleton

// Go live, on a tablet that was setting up (SettingUp): what was rung up goes,
// what was set up stays. One transaction for the database, then the tablet's
// own numbers, then the flag, last: a Go live cut short is finished by
// pressing it again. docs/superpowers/specs/2026-10-18-tablet-setting-up-design.md
@Singleton
class GoLive @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val printing: Printing,
) {
    // what the sheet says goes
    data class Rung(val receipts: Int, val orders: Int, val days: Int)
    suspend fun rung(): Rung = db.goLive().let { Rung(it.receipts(), it.orders(), it.days()) }

    suspend fun go(): Result<Unit> = runCatching {
        check(db.tryingOut(session)) { "This till is not being set up." }
        val store = session.storeId() ?: error("This tablet is not set up.")
        val device = session.deviceId() ?: error("This tablet is not set up.")
        val dao = db.goLive()
        db.withTransaction {
            // the shelf first, while what the sales noted is still there to read
            val counted = dao.countedAt().associate { (it.item_id to it.variant_id) to it.at }
            GoLiveRules.putBack(dao.noted().map { GoLiveRules.Noted(it.item_id, it.variant_id, it.qty, it.created_at) }, counted).forEach { (key, by) ->
                val (item, variant) = key
                if (db.retail().moveLevel(store, item, variant, by) == 0) db.retail().upsertLevels(listOf(StockLevelEntity(store, item, variant, by)))
            }
            dao.dropNoted()
            dao.clearRungUp()
            dao.dropQueued(GoLiveRules.RUNG_UP.toList())
            dao.numbersFromOne(device)
        }
        // Try again on a test receipt would print it as a real one
        printing.clearJobs()
        session.wentLive()
    }
}
