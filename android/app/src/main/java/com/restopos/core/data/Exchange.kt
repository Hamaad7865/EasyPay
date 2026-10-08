package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.database.ReceiptEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton

// What comes back in an exchange, kept while the cashier rings up what the
// customer takes instead.
data class ExchangeDraft(
    val ticketId: String, // the sale it is rung up on
    val receiptId: String,
    val number: String, // the receipt the goods come back from
    val picks: Map<String, Int>?, // order line id to quantity, in thousandths; null: the whole receipt
    val restock: Boolean,
    val reason: String,
    val approver: StaffMember?,
    val credit: Long, // what the goods coming back are worth
    val lines: Int, // how many lines come back
)

// An exchange: goods of a receipt come back and the customer takes something
// else on the same visit, and only the difference changes hands. On the books
// it is what it always was, a refund and a sale: the two documents the server
// takes already. This class holds what comes back until the new sale is paid,
// then writes the two together, in one transaction, the refund first.
//
// The part of the new sale that the returned goods pay for is neither cash
// nor card. It goes through the shop's payment type of kind "exchange"
// (migration 0079): out of the refund and into the sale, the same amount both
// ways. Cash and card only ever hold what really changed hands, so the drawer
// count and the day's report stay right.
//
// What comes back is kept in memory, by the sale it belongs to: a sale that
// is parked keeps its exchange, and another sale rung up meanwhile has none.
// A till that stops in between has made no refund and taken no money; the
// cashier starts the exchange again from the receipt.
@Singleton
class Exchanges @Inject constructor(
    private val db: TillDatabase,
    private val orders: OrderOps,
    private val tickets: TicketRepository,
    private val sales: RetailSales,
    private val staff: StaffSession,
    @ApplicationContext private val context: Context,
) {
    private val _drafts = MutableStateFlow<Map<String, ExchangeDraft>>(emptyMap())
    val drafts: StateFlow<Map<String, ExchangeDraft>> = _drafts

    fun of(ticketId: String?): ExchangeDraft? = ticketId?.let { _drafts.value[it] }
    fun cancel(ticketId: String?) { if (ticketId != null) _drafts.value = _drafts.value - ticketId }

    // what these lines of a receipt are worth today: what a refund of them would give back
    private suspend fun worth(receiptId: String, picks: Map<String, Int>?): Long {
        if (picks != null) return orders.refundQuote(receiptId, picks)
        val orig = db.ops().receipt(receiptId) ?: return 0
        return orig.total - db.ops().refundedOf(receiptId)
    }

    // The goods named come back, to be exchanged on the sale that is open (one
    // is opened if none is). Nothing is written yet. The right to refund is
    // asked for here, where the cashier is still in front of the receipt.
    suspend fun start(receiptId: String, reason: String, approver: StaffMember?, picks: Map<String, Int>?, restock: Boolean): Result<ExchangeDraft> = runCatching {
        staff.allow("sale.refund", "refund", approver)
        db.ops().exchangeType() ?: error("This till has not been sent the shop's Exchange payment type yet. Let it sync, or refund and then sell.")
        val orig = db.ops().receipt(receiptId) ?: error("That receipt is not on this tablet")
        require(orig.type == "sale") { "A refund cannot be exchanged" }
        val credit = worth(receiptId, picks)
        require(credit > 0) { "Pick what comes back" }
        // The exchange belongs to a sale, so there has to be one now: the one on
        // the register, or a new one (a sale is otherwise only made with its
        // first product; this one waits for it, and is the next sale if the
        // exchange is cancelled).
        sales.open()
        val ticket = tickets.ensureTicket()
        val draft = ExchangeDraft(
            ticket.id, receiptId, orig.number, picks, restock, reason.trim().ifBlank { "Exchange" }, approver, credit,
            picks?.count { it.value > 0 } ?: db.receipts().lines(receiptId).size,
        )
        _drafts.value = _drafts.value + (ticket.id to draft)
        draft
    }

    // The new sale is paid, and what comes back is refunded, together.
    //   saleTotal   what the new sale comes to
    //   difference  how the customer pays what it is worth more than the goods coming back (null: it is not)
    //   backTypeId  how the shop gives back what it is worth less (null: it is not)
    // Returns the refund and the sale.
    suspend fun complete(
        saleTotal: Long, difference: PayInput?, backTypeId: String?,
        discounts: List<DiscountPick>, servicePct: Int, covered: List<String>,
    ): Result<Pair<ReceiptEntity, ReceiptEntity>> = runCatching {
        val ticket = tickets.activeTicket() ?: error("no ticket")
        val d = of(ticket.id) ?: error("There is no exchange on this sale")
        val type = db.ops().exchangeType() ?: error("This till has not been sent the shop's Exchange payment type yet. Let it sync, or refund and then sell.")
        require(staff.can("payment.take")) { "You are not allowed to take payment" }
        require(saleTotal > 0) { "This sale comes to nothing. Cancel the exchange and refund the goods instead." }
        // another till may have refunded part of that receipt since
        val credit = worth(d.receiptId, d.picks)
        require(credit == d.credit) { "That receipt has changed since the exchange was started. Cancel it and start again from the receipt." }
        val settled = minOf(credit, saleTotal)
        require((difference?.amount ?: 0L) == saleTotal - settled) { "Payment must equal the amount due" }
        require(credit == settled || backTypeId != null) { "Pick how the difference is given back" }
        // One transaction for the two: a sale that cannot be written takes its refund back with it.
        val out = db.withTransaction {
            val refund = orders.refund(d.receiptId, d.reason, backTypeId ?: type.id, d.approver, d.picks, d.restock, toExchange = settled, quiet = true).getOrThrow()
            check(refund.total == credit) { "That receipt has changed since the exchange was started. Cancel it and start again from the receipt." }
            val sale = tickets.pay(
                listOfNotNull(PayInput(type.id, settled, reference = refund.number, label = "Returned goods"), difference),
                discounts, servicePct, covered,
            ).getOrThrow()
            refund to sale
        }
        cancel(ticket.id)
        pushNow(context)
        out
    }
}
