package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Transaction

// What Go live reads and clears on a tablet that was setting up
// (core/data/GoLive). Every table that holds what was rung up is named here,
// and no table of what was set up.
@Dao
interface GoLiveDao {
    // how much was rung up, for the sheet that asks
    @Query("SELECT COUNT(*) FROM receipts") suspend fun receipts(): Int
    @Query("SELECT COUNT(*) FROM tickets") suspend fun orders(): Int
    @Query("SELECT COUNT(*) FROM shifts") suspend fun days(): Int

    // what the sales moved on the shelf while setting up (moveStock, noted)
    @Query("SELECT * FROM stock_movements WHERE ref_type = 'trial'") suspend fun noted(): List<StockMovementEntity>
    @Query("DELETE FROM stock_movements WHERE ref_type = 'trial'") suspend fun dropNoted()

    // when each product was last set by a count completed here: counted, or set to nothing as not counted
    @Query(
        """SELECT l.item_id AS item_id, l.variant_id AS variant_id, MAX(c.completed_at) AS at
           FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id
           WHERE c.status = 'completed' AND c.completed_at IS NOT NULL AND l.left_out = 0 AND l.counted IS NOT NULL
           GROUP BY l.item_id, l.variant_id""",
    )
    suspend fun countedAt(): List<CountedAt>

    @Query("DELETE FROM outbox WHERE type IN (:kinds)") suspend fun dropQueued(kinds: List<String>)
    @Query("UPDATE pos_devices SET last_receipt_seq = 0 WHERE id = :device") suspend fun numbersFromOne(device: String)

    // children before what they belong to
    @Transaction
    suspend fun clearRungUp() {
        lineMods(); lineTaxes(); lines(); receiptTaxes(); receiptMods(); receiptLines(); receiptPayments(); receiptsAll()
        kdsParts(); kdsOut(); kdsTickets(); ticketsAll()
        accountPaymentLines(); accountPayments(); accountBills(); depositPayments(); depositLines(); depositsAll(); creditNotes()
        cash(); drawerCounts(); dayCloses(); shifts(); punches(); bookings(); requests(); guestOrders(); tillLog()
    }
    @Query("DELETE FROM ticket_line_modifiers") suspend fun lineMods()
    @Query("DELETE FROM ticket_line_taxes") suspend fun lineTaxes()
    @Query("DELETE FROM ticket_lines") suspend fun lines()
    @Query("DELETE FROM receipt_line_taxes") suspend fun receiptTaxes()
    @Query("DELETE FROM receipt_line_mods") suspend fun receiptMods()
    @Query("DELETE FROM receipt_lines") suspend fun receiptLines()
    @Query("DELETE FROM receipt_payments") suspend fun receiptPayments()
    @Query("DELETE FROM receipts") suspend fun receiptsAll()
    @Query("DELETE FROM kds_parts") suspend fun kdsParts()
    @Query("DELETE FROM kds_out") suspend fun kdsOut()
    @Query("DELETE FROM kds_tickets") suspend fun kdsTickets()
    @Query("DELETE FROM tickets") suspend fun ticketsAll()
    @Query("DELETE FROM account_payment_lines") suspend fun accountPaymentLines()
    @Query("DELETE FROM account_payments") suspend fun accountPayments()
    @Query("DELETE FROM account_bills") suspend fun accountBills()
    @Query("DELETE FROM deposit_payments") suspend fun depositPayments()
    @Query("DELETE FROM deposit_lines") suspend fun depositLines()
    @Query("DELETE FROM deposits") suspend fun depositsAll()
    @Query("DELETE FROM credit_notes") suspend fun creditNotes()
    @Query("DELETE FROM cash_movements") suspend fun cash()
    @Query("DELETE FROM drawer_counts") suspend fun drawerCounts()
    @Query("DELETE FROM day_closes") suspend fun dayCloses()
    @Query("DELETE FROM shifts") suspend fun shifts()
    @Query("DELETE FROM timeclock_punches") suspend fun punches()
    @Query("DELETE FROM bookings") suspend fun bookings()
    @Query("DELETE FROM till_requests") suspend fun requests()
    @Query("DELETE FROM guest_orders") suspend fun guestOrders()
    @Query("DELETE FROM till_log") suspend fun tillLog()
}

data class CountedAt(val item_id: String, val variant_id: String, val at: Long)
