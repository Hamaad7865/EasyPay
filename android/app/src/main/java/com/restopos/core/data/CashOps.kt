package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.database.CashMoveEntity
import com.restopos.core.database.DayCloseEntity
import com.restopos.core.database.DrawerCountEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.ShiftEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.CashSlipDoc
import com.restopos.core.print.DocAmount
import com.restopos.core.print.DocTax
import com.restopos.core.print.Docs
import com.restopos.core.print.DrawerCountDoc
import com.restopos.core.print.EscPos
import com.restopos.core.print.PrintError
import com.restopos.core.print.Printing
import com.restopos.core.print.ShiftDoc
import com.restopos.core.print.ZDoc
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

// The cash drawer and the closings: opening the drawer without a sale, cash
// put in and taken out, the shift report, and the day closing (Z). All of it
// is worked out from what this tablet holds, so it works with no connection.
@Singleton
class CashOps @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val printing: Printing,
    private val docs: DocBuilder,
    @ApplicationContext private val context: Context,
) {
    private fun op(type: String, payload: JsonObject) = OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())

    private suspend fun till(): String = session.deviceId()?.let { db.catalog().device(it)?.name } ?: "Till"
    private suspend fun name(id: String?): String? = id?.let { db.staff().employee(it)?.name }

    private suspend fun record(type: String, amount: Long, reason: String?, approvedBy: String? = null): CashMoveEntity {
        val tenant = session.tenantId() ?: error("no tenant")
        val store = session.storeId() ?: error("no store")
        val device = session.deviceId() ?: error("no device")
        val shift = db.staff().openShift(device)?.id
        val row = CashMoveEntity(Uuid7.next(), tenant, store, device, shift, staff.id(), type, amount, reason, System.currentTimeMillis())
        db.withTransaction {
            db.ops().upsertCashMoves(listOf(row))
            db.outbox().enqueue(op("cash.move", buildJsonObject {
                put("id", row.id); put("store_id", store); put("device_id", device); shift?.let { put("shift_id", it) }
                put("type", type); put("amount", amount); reason?.let { put("reason", it) }
                put("device_time", Instant.ofEpochMilli(row.device_time).toString())
                approvedBy?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
        return row
    }

    // The drawer opened with no sale. It is written down: a drawer that opens
    // for no reason is what an owner wants to know about.
    suspend fun openDrawer(approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("drawer.open_no_sale", "open the drawer without a sale", approver)
        val p = printing.receiptPrinter() ?: throw PrintError("The drawer opens through the receipt printer, and none is set up.")
        printing.send(p, EscPos(EscPos.columnsFor(p.paper_mm)).drawer().bytes(), "Open cash drawer", again = null).getOrThrow()
        record("drawer", 0, null, staff.approvedBy("drawer.open_no_sale", approver))
    }

    // Cash in or cash out: recorded first, then the slip for the drawer. The
    // slip not printing does not undo it: the cash has moved.
    suspend fun move(type: String, amount: Long, reason: String, approver: StaffMember? = null): Result<String?> = runCatching {
        require(type == "in" || type == "out") { "bad type" }
        require(amount > 0) { "Type the amount" }
        require(reason.isNotBlank()) { "Say what it is for" }
        staff.allow("cash.pay_in_out", "put cash in or take cash out", approver)
        val row = record(type, amount, reason.trim(), staff.approvedBy("cash.pay_in_out", approver))
        val p = printing.receiptPrinter() ?: return@runCatching "Recorded. No receipt printer is set up, so no slip was printed."
        val s = printing.settings()
        val slip = CashSlipDoc(type, amount, row.reason, row.device_time, staff.current.value?.employee?.name, till())
        // sent again later from the print jobs, the slip must not open the drawer
        printing.send(
            p, Docs.cashSlip(slip, printing.shop(), printing.paper(p), s.decimals), if (type == "in") "Cash in slip" else "Cash out slip",
            again = Docs.cashSlip(slip, printing.shop(), printing.paper(p), s.decimals, openDrawer = false),
        ).fold({ null }, { "Recorded, but the slip did not print: ${it.message}" })
    }

    // Counting the drawer during a shift, at a handover: what was counted and
    // what the drawer should have held are recorded, and a slip prints for
    // the two people to sign. Nothing closes, and the shift's expected cash at
    // its end is worked out as if nobody had counted.
    suspend fun count(counted: Long, approver: StaffMember? = null): Result<DrawerCountEntity> = runCatching {
        require(counted >= 0) { "Type the amount" }
        staff.allow("shift.open_close", "count the drawer", approver)
        val tenant = session.tenantId() ?: error("no tenant")
        val store = session.storeId() ?: error("no store")
        val device = session.deviceId() ?: error("no device")
        val shift = db.staff().openShift(device) ?: error("No shift is open")
        val now = System.currentTimeMillis()
        val row = DrawerCountEntity(Uuid7.next(), tenant, store, device, shift.id, staff.id(), counted, expectedCash(shift, now), now)
        db.withTransaction {
            db.ops().upsertDrawerCounts(listOf(row))
            db.outbox().enqueue(op("drawer.count", buildJsonObject {
                put("id", row.id); put("store_id", store); put("device_id", device); put("shift_id", shift.id)
                put("counted", counted); put("expected", row.expected)
                put("device_time", Instant.ofEpochMilli(now).toString())
                staff.approvedBy("shift.open_close", approver)?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
        printing.scope.launch {
            val p = printing.receiptPrinter() ?: return@launch
            val doc = DrawerCountDoc(row.device_time, name(row.employee_id), row.counted, row.expected, till())
            printing.send(p, Docs.drawerCount(doc, printing.shop(), printing.paper(p), printing.settings().decimals), "Drawer count slip")
                .onFailure { printing.report(it.message ?: "The drawer count slip did not print") }
        }
        row
    }

    // ---- the figures of a period on this till ----

    private class Period(
        val sales: Int, val gross: Long, val refunds: Int, val refunded: Long, val discounts: Long, val tax: Long,
        val payments: List<DocAmount>, val cashTaken: Long, val cashIn: Long, val cashOut: Long, val moves: List<CashSlipDoc>,
        val categories: List<DocAmount>, val taxes: List<DocTax>, val first: String?, val last: String?,
    )

    private suspend fun period(device: String, from: Long, to: Long): Period {
        val receipts = db.ops().receiptsBetween(device, from, to)
        val sales = receipts.filter { it.type == "sale" }
        val refunds = receipts.filter { it.type == "refund" }
        val types = db.ops().allPaymentTypes().associateBy { it.id }
        val pay = LinkedHashMap<String, DocAmount>()
        var cash = 0L
        db.ops().paidBetween(device, from, to).forEach { r ->
            val signed = if (r.type == "refund") -r.amount else r.amount
            val name = types[r.payment_type_id]?.name ?: "Other"
            val cur = pay[name]
            pay[name] = DocAmount(name, (cur?.amount ?: 0) + signed, (cur?.count ?: 0) + 1)
            if (types[r.payment_type_id]?.kind == "cash") cash += signed
        }
        val till = till()
        val moves = db.ops().cashMoves(device, from, to).filter { it.type != "drawer" }
            .map { CashSlipDoc(it.type, it.amount, it.reason, it.device_time, name(it.employee_id), till) }
        // by category and by tax, from what each receipt printed
        val cats = LinkedHashMap<String, DocAmount>()
        val taxes = LinkedHashMap<String, DocTax>()
        receipts.forEach { r ->
            val sign = if (r.type == "refund") -1 else 1
            val d = docs.decode(r.doc) ?: return@forEach
            d.lines.forEach { l ->
                val key = l.cat ?: "No category"
                val cur = cats[key]
                cats[key] = DocAmount(key, (cur?.amount ?: 0) + sign * l.amount, (cur?.count ?: 0) + sign * (l.qty / 1000))
            }
            d.taxes.forEach { t ->
                val key = "${t.name}:${t.rateBp}"
                val cur = taxes[key]
                taxes[key] = DocTax(t.name, t.rateBp, (cur?.amount ?: 0) + sign * t.amount, t.included)
            }
        }
        return Period(
            sales.size, sales.sumOf { it.total }, refunds.size, refunds.sumOf { it.total },
            sales.sumOf { it.discount_total } - refunds.sumOf { it.discount_total }, sales.sumOf { it.tax_total } - refunds.sumOf { it.tax_total },
            pay.values.sortedByDescending { it.amount }, cash, moves.filter { it.type == "in" }.sumOf { it.amount },
            moves.filter { it.type == "out" }.sumOf { it.amount }, moves, cats.values.sortedByDescending { it.amount }, taxes.values.toList(),
            sales.firstOrNull()?.number, sales.lastOrNull()?.number,
        )
    }

    // What should be in the drawer now: the float, the cash taken (refunds
    // paid in cash come off), cash put in, less cash taken out.
    suspend fun expectedCash(shift: ShiftEntity, until: Long = System.currentTimeMillis()): Long {
        val p = period(shift.device_id, shift.opened_at - 1, shift.closed_at ?: until)
        return shift.opening_float + p.cashTaken + p.cashIn - p.cashOut
    }

    suspend fun shiftDoc(shift: ShiftEntity): ShiftDoc {
        val p = period(shift.device_id, shift.opened_at - 1, shift.closed_at ?: System.currentTimeMillis())
        val expected = shift.opening_float + p.cashTaken + p.cashIn - p.cashOut
        val till = till()
        return ShiftDoc(
            till, name(shift.opened_by), shift.opened_at, name(shift.closed_by), shift.closed_at, shift.opening_float,
            p.payments, p.cashTaken, p.cashIn, p.cashOut, p.moves, shift.expected_cash ?: expected, shift.counted_cash,
            p.sales, p.gross, p.refunds, p.refunded, p.discounts,
            db.ops().drawerCounts(shift.id).map { DrawerCountDoc(it.device_time, name(it.employee_id), it.counted, it.expected, till) },
        )
    }

    suspend fun printShift(shift: ShiftEntity): Result<Unit> = runCatching {
        val p = printing.receiptPrinter() ?: throw PrintError("No receipt printer is set up. Add one in the back office, under Printers.")
        printing.send(p, Docs.shift(shiftDoc(shift), printing.shop(), printing.paper(p), printing.settings().decimals), "Shift report").getOrThrow()
    }

    // After a shift is closed: its report, without holding the till up.
    fun printShiftBehind(shift: ShiftEntity) {
        printing.scope.launch {
            if (printing.receiptPrinter() != null) printShift(shift).onFailure { printing.report(it.message ?: "The shift report did not print") }
        }
    }

    suspend fun currentShift(): ShiftEntity? = session.deviceId()?.let { db.staff().openShift(it) }
    suspend fun closedShifts(): List<ShiftEntity> = session.deviceId()?.let { db.staff().closedShifts(it) } ?: emptyList()
    suspend fun dayCloses(): List<DayCloseEntity> = session.deviceId()?.let { db.ops().dayCloses(it) } ?: emptyList()
    suspend fun employeeName(id: String?): String? = name(id)
    suspend fun lastShift(): ShiftEntity? = session.deviceId()?.let { db.staff().openShift(it) ?: db.staff().lastClosedShift(it) }

    // The day so far: everything since the last day closing.
    suspend fun dayDoc(closedAt: Long = System.currentTimeMillis(), number: Int? = null): ZDoc {
        val device = session.deviceId() ?: error("no device")
        val last = db.ops().lastDayClose(device)
        val p = period(device, last?.closed_at ?: 0, closedAt)
        return ZDoc(
            number ?: ((last?.number ?: 0) + 1), till(), last?.closed_at, closedAt, staff.current.value?.employee?.name,
            p.sales, p.gross, p.refunds, p.refunded, p.discounts, p.tax, p.payments, p.categories, p.taxes,
            p.cashIn, p.cashOut, p.moves, p.first, p.last,
        )
    }

    // A day closing already made, as it was: the same period, the same number.
    suspend fun dayDocOf(row: DayCloseEntity): ZDoc {
        val p = period(row.device_id, row.from_time ?: 0, row.closed_at)
        return ZDoc(
            row.number, till(), row.from_time, row.closed_at, name(row.closed_by),
            p.sales, p.gross, p.refunds, p.refunded, p.discounts, p.tax, p.payments, p.categories, p.taxes,
            p.cashIn, p.cashOut, p.moves, p.first, p.last,
        )
    }

    suspend fun printZOf(row: DayCloseEntity): Result<Unit> = printZ(dayDocOf(row))

    // The day so far, by who took the payment.
    suspend fun staffSales(): List<DocAmount> {
        val device = session.deviceId() ?: return emptyList()
        val out = LinkedHashMap<String, DocAmount>()
        db.ops().receiptsBetween(device, db.ops().lastDayClose(device)?.closed_at ?: 0, System.currentTimeMillis()).forEach { r ->
            val who = docs.decode(r.doc)?.cashier ?: "No name"
            val cur = out[who]
            out[who] = DocAmount(who, (cur?.amount ?: 0) + (if (r.type == "refund") -r.total else r.total), (cur?.count ?: 0) + if (r.type == "sale") 1 else 0)
        }
        return out.values.sortedByDescending { it.amount }
    }

    // Closing the day: the shift must be closed first (the drawer counted),
    // then the Z is fixed at this moment, sent, and printed. With "start again
    // each day", the next bill is number 1 of the next closing.
    suspend fun closeDay(approver: StaffMember? = null): Result<Pair<ZDoc, String?>> = runCatching {
        staff.allow("shift.open_close", "close the day", approver)
        val tenant = session.tenantId() ?: error("no tenant")
        val store = session.storeId() ?: error("no store")
        val device = session.deviceId() ?: error("no device")
        require(db.staff().openShift(device) == null) { "Close the shift first: the drawer has to be counted before the day is closed." }
        require(db.tickets().unpaidOrderCount() == 0L) { "There are still unpaid orders. Take payment for them, or void them, before closing the day." }
        val now = System.currentTimeMillis()
        val last = db.ops().lastDayClose(device)
        val z = dayDoc(now)
        val row = DayCloseEntity(Uuid7.next(), tenant, store, device, z.number, staff.id(), last?.closed_at, now)
        db.withTransaction {
            db.ops().upsertDayCloses(listOf(row))
            db.outbox().enqueue(op("day.close", buildJsonObject {
                put("id", row.id); put("store_id", store); put("device_id", device)
                put("closed_at", Instant.ofEpochMilli(now).toString())
                put("totals", buildJsonObject {
                    put("sales", z.sales); put("gross", z.gross); put("refunds", z.refunds); put("refunded", z.refunded)
                    put("discounts", z.discounts); put("tax", z.tax); put("cash_in", z.cashIn); put("cash_out", z.cashOut)
                })
                staff.approvedBy("shift.open_close", approver)?.let { put("approved_by", it) }
            }))
        }
        session.setPeriodSeq(0)
        pushNow(context)
        z to printZ(z).exceptionOrNull()?.message
    }

    suspend fun printZ(z: ZDoc): Result<Unit> = runCatching {
        val p = printing.receiptPrinter() ?: throw PrintError("No receipt printer is set up, so the closing report was not printed. It is in the back office, under Day closing.")
        val s = printing.settings()
        printing.send(p, Docs.z(z, printing.shop(), printing.paper(p), s.decimals, s.dayCloseDetailed), "Day closing no. ${z.number}").getOrThrow()
    }
}
