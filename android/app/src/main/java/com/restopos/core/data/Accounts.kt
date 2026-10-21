package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.database.AccountBillEntity
import com.restopos.core.database.AccountPaymentEntity
import com.restopos.core.database.AccountPaymentLineEntity
import com.restopos.core.database.CashMoveEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.database.owed
import com.restopos.core.print.DocAmount
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

// Money handed over for an account payment: the payment type, the amount,
// and for cash what was tendered.
data class AccountMoney(val paymentTypeId: String, val amount: Long, val tendered: Long? = null, val change: Long = 0, val reference: String? = null)

// A shop's customer accounts on this tablet (server 0114; the spec is
// docs/superpowers/specs/2026-10-17-customer-accounts-design.md). A sale paid
// "On account" writes its bill in TicketRepository.pay, a return takes off it
// in OrderOps.refund; this is the rest: who owes, taking money on the bills
// the cashier ticks, and the papers. Like every write on the till: the rows
// and the outbox op in ONE transaction, then a push. Cash is a row of the
// drawer's (naming the payment), with no cash.move op: the server writes the
// same row from account.pay.
@Singleton
class Accounts @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    // what takes an order or moves money waits for the day and a clocked-in person (SellGate)
    private val sell: SellCheck,
    private val docs: DocBuilder,
    @ApplicationContext private val context: Context,
) {
    // one that takes an order or moves money waits for the gate (SellCheck)
    private suspend fun op(type: String, payload: JsonObject): OutboxEntity {
        sell.check(type)
        return OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())
    }

    suspend fun settings() = PosSettings.parse(db.ops().settings())

    // ---- reading ----
    fun owing() = db.accounts().owing()
    fun open(customerId: String) = db.accounts().open(customerId)
    suspend fun balance(customerId: String) = db.accounts().balance(customerId)
    suspend fun customer(id: String) = db.customers().customer(id)
    suspend fun pending() = db.accounts().openCount()

    // ---- taking money on the bills ticked ----

    // The amount goes on the bills ticked, oldest first (AccountRules.split).
    suspend fun pay(customerId: String, billIds: Collection<String>, m: AccountMoney): Result<AccountPaymentEntity> = runCatching {
        require(staff.can("payment.take")) { "You are not allowed to take payment" }
        val ticked = db.accounts().bills(billIds.toList()).filter { it.customer_id == customerId && it.owed > 0 }
        AccountRules.payError(m.amount, ticked.sumOf { it.owed })?.let { error(it) }
        val type = db.ops().paymentType(m.paymentTypeId) ?: error("Pick how it is paid")
        require(type.kind !in FIXED) { "Pick another way to pay" }
        if (type.kind == "cash" && m.tendered != null) require(m.tendered >= m.amount && m.change == m.tendered - m.amount) { "Tendered amount is below the payment" }
        val store = session.storeId() ?: error("no store")
        val device = session.deviceId() ?: error("no device")
        val till = db.catalog().device(device) ?: error("no device")
        val storeRow = db.catalog().store(store) ?: error("no store")
        val tenant = session.tenantId() ?: error("no tenant")
        val shift = db.staff().openShift(device) ?: error("Open the day first: money taken goes in the day's drawer")
        val split = AccountRules.split(m.amount, ticked.map { AccountRules.Owing(it.id, it.day, it.owed) })
        val number = AccountRules.next(storeRow.code, till.code, db.accounts().numbersOf(device, AccountRules.prefix(storeRow.code, till.code)))
        val now = System.currentTimeMillis()
        val p = AccountPaymentEntity(Uuid7.next(), number, customerId, store, device, shift.id, staff.id(), type.id,
            m.amount, m.tendered.takeIf { type.kind == "cash" }, if (type.kind == "cash") m.change else 0, m.reference?.trim()?.ifEmpty { null }, now)
        val lines = split.map { (bill, amount) -> AccountPaymentLineEntity(Uuid7.next(), p.id, bill, amount) }
        val byId = ticked.associateBy { it.id }
        db.withTransaction {
            db.accounts().upsertPayment(p)
            db.accounts().upsertPaymentLines(lines)
            db.accounts().upsertBills(split.map { (bill, amount) -> byId.getValue(bill).let { it.copy(paid = it.paid + amount) } })
            if (type.kind == "cash") db.ops().upsertCashMoves(listOf(CashMoveEntity(
                p.id, tenant, store, device, shift.id, p.employee_id, "in", p.amount, "Account payment $number", now, account_payment_id = p.id,
            )))
            db.outbox().enqueue(op("account.pay", buildJsonObject {
                put("id", p.id); put("number", number); put("customer_id", customerId)
                put("store_id", store); put("device_id", device); put("shift_id", shift.id)
                put("device_time", Instant.ofEpochMilli(now).toString())
                put("payment", buildJsonObject {
                    put("payment_type_id", type.id); put("amount", p.amount)
                    p.tendered?.let { put("tendered", it); put("change", p.change) }
                    p.reference?.let { put("reference", it) }
                })
                put("lines", buildJsonArray { lines.forEach { l -> add(buildJsonObject { put("bill_id", l.bill_id); put("amount", l.amount) }) } })
            }))
        }
        pushNow(context)
        p
    }

    // ---- paper ----

    // A payment's slip: what was paid and how, the bills it went on, what is
    // still owed. The drawer opens when it was cash. A slip that does not
    // print leaves everything as it is: the money moved.
    suspend fun printPayment(paymentId: String, openDrawer: Boolean = false): Result<Unit> = runCatching {
        val p = db.accounts().payment(paymentId) ?: error("That payment is gone")
        val c = db.customers().customer(p.customer_id)
        val paidOn = db.accounts().paymentLines(p.id).map { l -> DocAmount(db.accounts().bill(l.bill_id)?.let { label(it) } ?: "Bill", l.amount) }
        val type = db.ops().paymentType(p.payment_type_id)
        val money = listOfNotNull(
            DocAmount(type?.name ?: "Paid", p.amount),
            p.tendered?.let { DocAmount("Tendered", it) },
            p.change.takeIf { it > 0 }?.let { DocAmount("Change", it) },
        )
        val open = db.accounts().openNow(p.customer_id)
        docs.printAccount(com.restopos.core.print.AccountDoc(
            "ACCOUNT PAYMENT", p.number, c?.name ?: "Customer", c?.phone, p.device_time, staff.current.value?.employee?.name,
            open.map { DocAmount(label(it), it.owed) }, money, paidOn, balance = db.accounts().balance(p.customer_id),
        ), openDrawer).getOrThrow()
    }

    // A short statement: every bill that still owes, the ages, the balance.
    suspend fun printStatement(customerId: String): Result<Unit> = runCatching {
        val c = db.customers().customer(customerId) ?: error("That customer is gone")
        val open = db.accounts().openNow(customerId)
        val aged = AccountRules.aged(open.map { AccountRules.Owing(it.id, it.day, it.owed) }, LocalDate.now())
        docs.printAccount(com.restopos.core.print.AccountDoc(
            "STATEMENT", null, c.name, c.phone, System.currentTimeMillis(), staff.current.value?.employee?.name,
            open.map { DocAmount(label(it), it.owed) },
            aged = AccountRules.BUCKETS.mapIndexed { i, b -> DocAmount(b, aged[i]) },
            balance = db.accounts().balance(customerId),
        ), false).getOrThrow()
    }

    suspend fun paymentName(id: String) = db.ops().paymentType(id)?.name ?: "Paid"

    companion object {
        // never money taken at the counter: not a way to pay an account
        val FIXED = setOf("exchange", "credit_note", "deposit", "account")
        private val DAY = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)
        fun dayWords(day: String): String = runCatching { LocalDate.parse(day).format(DAY) }.getOrDefault(day)
        fun label(b: AccountBillEntity) = "${dayWords(b.day)} · ${b.number}"
    }
}
