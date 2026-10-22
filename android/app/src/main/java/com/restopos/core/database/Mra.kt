package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

// One document this till issued for the MRA (design section 8, server 0132's
// mra_records): made inside the sale's own transaction, with its counter,
// number and hash, and the invoice as it is sent. Only the MRA's answer is
// written after it is made.
//   status   waiting     not sent yet, or the MRA never saw it
//            unsure      sent once with no answer: it may be fiscalised; sent once more
//            check       sent twice with no answer: not sent again until a manager says so
//            fiscalised  the MRA gave it its IRN and QR code
//            refused     the MRA answered with its reasons: never sent again
@Entity(tableName = "mra_invoices", indices = [Index("status"), Index("counter"), Index("receipt_id")])
data class MraInvoiceEntity(
    @PrimaryKey val id: String, // the receipt's id; a debug test case its own
    val tenant_id: String,
    val store_id: String,
    val device_id: String,
    val ebs_id: String,
    val receipt_id: String?,
    val type: String, // STD, CRN, TRN (DRN and PRF from the debug build only)
    val counter: Long,
    val identifier: String,
    val ref_identifier: String?,
    val previous_hash: String,
    val invoice: String,
    val issued_at: Long,
    val status: String = "waiting",
    // sends that went out and got no answer
    val unanswered: Int = 0,
    val irn: String? = null,
    val qr: String? = null,
    val errors: String = "[]",
    val warnings: String = "[]",
    val answered_at: Long? = null,
    val response_id: String? = null,
)

// a document's identifier and where it stands
data class MraIdStatus(val identifier: String, val status: String)

// What waits, and what went wrong, for Settings, MRA and the banner.
// holdingBack: the sale a waiting credit note names that was sent twice with
// no answer (check). MraQueue stops at that credit note, so it and every
// invoice after it wait until a manager checks the sale.
data class MraCounts(val waiting: Int, val check: Int, val refused: Int, val oldestWaiting: Long?, val lastFiscalised: Long?, val holdingBack: String? = null)

@Dao
interface MraDao {
    @Insert suspend fun insert(e: MraInvoiceEntity)

    @Query("SELECT * FROM mra_invoices WHERE id = :id") suspend fun byId(id: String): MraInvoiceEntity?
    @Query("SELECT * FROM mra_invoices WHERE receipt_id = :receipt") suspend fun byReceipt(receipt: String): MraInvoiceEntity?
    @Query("SELECT * FROM mra_invoices WHERE id IN (:ids)") suspend fun byIds(ids: List<String>): List<MraInvoiceEntity>

    // what is still to send, oldest first
    @Query("SELECT * FROM mra_invoices WHERE status IN ('waiting', 'unsure') ORDER BY counter LIMIT :limit")
    suspend fun waiting(limit: Int): List<MraInvoiceEntity>

    @Query("SELECT identifier, status FROM mra_invoices WHERE identifier IN (:ids)") suspend fun statusOf(ids: List<String>): List<MraIdStatus>

    // the last of a type this till issued, for the next one's hash
    @Query("SELECT * FROM mra_invoices WHERE type = :type ORDER BY counter DESC LIMIT 1") suspend fun lastOfType(type: String): MraInvoiceEntity?
    @Query("SELECT MAX(issued_at) FROM mra_invoices") suspend fun latestIssuedAt(): Long?

    // Written just before a request goes: from then on it may have reached the
    // MRA. A second send with no answer leaves it to be checked.
    @Query("UPDATE mra_invoices SET unanswered = unanswered + 1, status = CASE WHEN unanswered + 1 >= 2 THEN 'check' ELSE 'unsure' END WHERE id IN (:ids)")
    suspend fun sending(ids: List<String>)

    // the request did not reach the MRA, or the MRA refused it whole: as before it went
    @Query("UPDATE mra_invoices SET unanswered = MAX(unanswered - 1, 0), status = CASE WHEN unanswered - 1 <= 0 THEN 'waiting' ELSE 'unsure' END WHERE id IN (:ids)")
    suspend fun notSent(ids: List<String>)

    @Query("UPDATE mra_invoices SET status = :status, irn = :irn, qr = :qr, errors = :errors, warnings = :warnings, answered_at = :at, response_id = :response WHERE id = :id AND status NOT IN ('fiscalised', 'refused')")
    suspend fun answer(id: String, status: String, irn: String?, qr: String?, errors: String, warnings: String, at: Long, response: String?)

    // a manager's Send again, once, for one sent twice without an answer
    @Query("UPDATE mra_invoices SET status = 'unsure', unanswered = 1 WHERE id = :id AND status = 'check'")
    suspend fun sendAgain(id: String): Int

    @Query(
        """SELECT COALESCE(SUM(status IN ('waiting', 'unsure')), 0) AS waiting, COALESCE(SUM(status = 'check'), 0) AS `check`,
                  COALESCE(SUM(status = 'refused'), 0) AS refused,
                  MIN(CASE WHEN status IN ('waiting', 'unsure') THEN issued_at END) AS oldestWaiting,
                  MAX(CASE WHEN status = 'fiscalised' THEN answered_at END) AS lastFiscalised,
                  (SELECT s.identifier FROM mra_invoices c JOIN mra_invoices s ON s.identifier = c.ref_identifier
                    WHERE c.type = 'CRN' AND c.status IN ('waiting', 'unsure') AND s.status = 'check'
                    ORDER BY c.counter LIMIT 1) AS holdingBack
           FROM mra_invoices""",
    )
    fun counts(): Flow<MraCounts>

    @Query("SELECT * FROM mra_invoices WHERE status IN ('check', 'refused') ORDER BY counter DESC LIMIT 50")
    fun problems(): Flow<List<MraInvoiceEntity>>
}
