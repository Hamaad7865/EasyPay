package com.restopos.core.data

import com.restopos.core.database.DayCloseEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.Docs
import com.restopos.core.print.PrintError
import com.restopos.core.print.Printing
import com.restopos.core.print.ReportDoc
import com.restopos.core.print.ReportLine
import com.restopos.core.print.ZDoc
import com.restopos.core.sync.SessionStore
import javax.inject.Inject
import javax.inject.Singleton

// What the till's reports are read from (feature/reports): this till's own
// receipts for a period, each with what it printed; the period's figures as
// the day closings work them out; the days closed in it; and the printing of
// a report on the receipt printer. Everything is the tablet's own database:
// no report asks the server anything.
@Singleton
class ReportsRepository @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val cash: CashOps,
    private val docs: DocBuilder,
    private val printing: Printing,
) {
    // One day opened and closed on this till: the closing, and the drawer it closed with when it had one.
    class ShiftRow(
        val close: DayCloseEntity, val openedAt: Long?, val openedBy: String?, val closedBy: String?,
        val float: Long?, val expected: Long?, val counted: Long?,
    )

    // This till's receipts and refunds of the period, oldest first.
    suspend fun sales(span: Reports.Span): List<Reports.Sale> {
        val device = session.deviceId() ?: return emptyList()
        return db.ops().receiptsBetween(device, span.from, span.to).map { r ->
            val refund = r.type == "refund"
            Reports.Sale(r.id, r.number, refund, if (refund) r.refund_of?.let { db.ops().receipt(it)?.number } else null, r.device_time, r.total, docs.decode(r.doc))
        }
    }

    suspend fun figures(span: Reports.Span): CashOps.Figures? = cash.figures(span.from, span.to)

    // The days closed in the period, newest first.
    suspend fun days(span: Reports.Span): List<ShiftRow> {
        val device = session.deviceId() ?: return emptyList()
        val shifts = db.staff().closedShifts(device, 400)
        return db.ops().dayClosesBetween(device, span.from, span.to).map { row ->
            val shift = shifts.firstOrNull { it.closed_at == row.closed_at }
            ShiftRow(row, shift?.opened_at, cash.employeeName(shift?.opened_by), cash.employeeName(row.closed_by), shift?.opening_float, shift?.expected_cash, shift?.counted_cash)
        }
    }

    // A day closing already made, as it was, and its report printed again.
    suspend fun dayDoc(row: DayCloseEntity): ZDoc = cash.dayDocOf(row)
    suspend fun printDay(row: DayCloseEntity): Result<Unit> = cash.printZOf(row)

    // When this till rang up its first receipt: its reports know nothing of before.
    suspend fun since(): Long? = session.deviceId()?.let { db.ops().firstReceiptAt(it) }

    // ---- what the tablet wrote down itself (till_log) ----
    private suspend fun logged(kind: String, span: Reports.Span): List<Reports.Logged> = db.log().between(kind, span.from, span.to).map {
        Reports.Logged(it.at, cash.employeeName(it.employee_id), cash.employeeName(it.approved_by), it.item_id, it.variant_id, it.receipt_id, it.was, it.became)
    }

    // Products whose own price was changed on this till in the period, newest first.
    suspend fun priceChanges(span: Reports.Span): List<Reports.PriceChange> {
        val rows = logged("price", span)
        val names = HashMap<Pair<String, String?>, String?>()
        for (r in rows) {
            val item = r.item ?: continue
            if (names.containsKey(item to r.variant)) continue
            val name = db.catalog().item(item)?.name
            val variant = r.variant?.let { v -> db.retail().variant(v)?.name }
            names[item to r.variant] = if (name == null) null else if (variant != null) "$name, $variant" else name
        }
        return Reports.priceChanges(rows) { item, variant -> names[item to variant] }
    }

    // Payments whose type was corrected on this till in the period, newest first.
    suspend fun corrected(span: Reports.Span): List<Reports.Corrected> {
        val rows = logged("payment", span)
        val numbers = HashMap<String, String?>()
        for (id in rows.mapNotNull { it.receipt }.distinct()) numbers[id] = db.ops().receipt(id)?.number
        return Reports.corrected(rows) { numbers[it] }
    }

    // When the tablet began writing these down: nothing is known of before.
    suspend fun logSince(): Long? = db.log().first()

    suspend fun decimals(): Int = printing.settings().decimals
    // a shop has no order types to cut its sales by
    suspend fun retail(): Boolean = printing.settings().retail

    // A report on the receipt printer, as narrow columns.
    suspend fun print(title: String, span: Reports.Span, lines: List<ReportLine>): Result<Unit> = runCatching {
        val p = printing.receiptPrinter() ?: throw PrintError("No receipt printer is set up. Add one under Printers.")
        val doc = ReportDoc(title, Reports.says(span), cash.tillName(), System.currentTimeMillis(), lines)
        printing.send(p, Docs.report(doc, printing.shop(), printing.paper(p)), title).getOrThrow()
    }
}
