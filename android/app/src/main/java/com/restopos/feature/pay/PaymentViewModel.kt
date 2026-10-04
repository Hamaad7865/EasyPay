package com.restopos.feature.pay

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.tableLabel
import com.restopos.core.data.Calc
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.OrderOps
import com.restopos.core.data.PayInput
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.ReceiptEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

// Payment (spec 7.5): cash takes the amount received and gives the change;
// the other types take an optional reference (manual record in v1).
//
// A bill is split two ways. By item: tick the lines one guest pays for (or
// open one check of a split check), take the payment, and the rest stays on
// the order for the next receipt. By amount: the amount due is paid in
// several shares, each with its own payment type, split evenly between a
// number of guests or typed in. The shares are kept here until they add up
// to the amount due, and then go out as ONE receipt with all its payments:
// a receipt always pays its lines in full (the server would store a part
// payment, but flagged for review). Split evenly, each guest gets their own
// printed copy of that receipt, saying their share and the tax in it.
data class PayLine(val id: String, val qty: Int, val name: String, val amount: Long, val selected: Boolean)

// A share already taken: who paid what, and how.
data class Share(val type: String, val input: PayInput)

sealed interface PayUiState {
    data object Loading : PayUiState
    data class Ready(
        val title: String, // the order's name: its tab name, else its table
        val lines: List<PayLine>, // unpaid lines; the receipt covers the ticked ones
        val due: Long, // total of the ticked lines, discount included
        val methods: List<PaymentTypeEntity>,
        val selected: PaymentTypeEntity?,
        val tendered: Long?, // cash received, in cents; null = exactly this payment's amount
        val reference: String,
        val error: String?,
        val notice: String? = null,
        val note: String = "", // a remark for the kitchen and the receipt
        val shares: List<Share> = emptyList(), // taken so far, not recorded yet
        val ways: Int = 1, // how many equal shares are still to come, this one included
        val custom: Long? = null, // an amount typed in for this payment
        val check: Int? = null, // the check of a split check being paid
        val perGuest: Boolean = false, // split evenly between guests: each gets their own copy of the receipt
    ) : PayUiState {
        val taken: Long get() = shares.sumOf { it.input.amount }
        val remaining: Long get() = due - taken
        // What this payment is for: the typed amount, else an equal share of
        // what is left (the last share takes the remainder), else all of it.
        val now: Long
            get() = when {
                custom != null -> custom.coerceIn(0, remaining)
                ways > 1 -> Money.share(remaining, ways)
                else -> remaining
            }
    }

    data class Done(val receipt: ReceiptEntity, val change: Long) : PayUiState
}

@HiltViewModel
class PaymentViewModel @Inject constructor(
    private val tickets: TicketRepository,
    private val db: TillDatabase,
    private val session: SessionStore,
    private val orderOps: OrderOps,
) : ViewModel() {
    private val _state = MutableStateFlow<PayUiState>(PayUiState.Loading)
    val state: StateFlow<PayUiState> = _state
    private var discount: DiscountPick? = null
    private var calc: Map<String, Calc.Line> = emptyMap()
    private var paying = false // a second tap on Pay while the first is being recorded does nothing

    // Set when one check of a split check has been paid and others remain:
    // the screen goes back to the checks.
    private val _checkPaid = MutableStateFlow(false)
    val checkPaid: StateFlow<Boolean> = _checkPaid

    init { reload(notice = null) }

    private fun dueFor(ids: Set<String>): Long {
        val picked = calc.filterKeys { ids.contains(it) }.values.toList()
        val d = discount
        return Calc.totalsRounded(picked, listOfNotNull(d?.let { Calc.Discount(if (it.type == "percent") it.value.toInt() else null, it.value) })).total
    }

    // Loads what is still unpaid. Every line starts ticked (paying the whole
    // bill is the common case), unless one check of a split check was opened:
    // then only that check's lines are.
    private fun reload(notice: String?) = viewModelScope.launch {
        val t = tickets.activeTicket() ?: return@launch
        val unpaid = db.tickets().lines(t.id).first().filter { it.voided_at == null && !it.paid }
        val amounts = HashMap<String, Long>()
        calc = unpaid.associate { l ->
            val base = Calc.lineAmount(l.unit_price, l.qty) + db.tickets().modSum(l.id)
            amounts[l.id] = base
            l.id to Calc.Line(base, db.catalog().lineTaxes(l.id).map { Calc.TaxRate(it.rate_bp, it.type) })
        }
        discount = tickets.pendingDiscount()
        val methods = db.catalog().paymentTypes().first()
        val cur = _state.value as? PayUiState.Ready
        val check = session.payCheck()
        session.setPayCheck(null)
        val lines = unpaid.map { PayLine(it.id, it.qty, it.name_snapshot, amounts[it.id] ?: 0, check == null || it.check_no == check) }
        val name = t.name ?: t.table_id?.let { db.tables().table(it)?.name }?.let { tableLabel(it) }
            ?: t.customer_id?.let { db.customers().customer(it)?.name } ?: "Direct sale"
        _state.value = PayUiState.Ready(
            if (check != null) "$name · Check $check" else name, lines, dueFor(lines.filter { it.selected }.map { it.id }.toSet()), methods,
            cur?.selected ?: methods.firstOrNull(), null, "", null, notice, cur?.note ?: t.note ?: "", check = check,
        )
    }

    // Which lines a payment covers is fixed once a share of it has been taken.
    fun toggle(lineId: String) {
        val s = _state.value as? PayUiState.Ready ?: return
        if (s.shares.isNotEmpty()) { _state.value = s.copy(error = "Part of this bill is already paid. Finish it, or cancel to start again."); return }
        val lines = s.lines.map { if (it.id == lineId) it.copy(selected = !it.selected) else it }
        _state.value = s.copy(lines = lines, due = dueFor(lines.filter { it.selected }.map { it.id }.toSet()), tendered = null, custom = null, error = null)
    }

    fun select(m: PaymentTypeEntity) {
        val s = _state.value as? PayUiState.Ready ?: return
        _state.value = s.copy(selected = m, tendered = null, reference = "", error = null)
    }

    fun tendered(cents: Long?) {
        val s = _state.value as? PayUiState.Ready ?: return
        _state.value = s.copy(tendered = cents?.coerceIn(0, 99_999_999), error = null)
    }

    fun reference(v: String) {
        val s = _state.value as? PayUiState.Ready ?: return
        _state.value = s.copy(reference = v.take(64))
    }

    fun note(v: String) {
        val s = _state.value as? PayUiState.Ready ?: return
        _state.value = s.copy(note = v.take(120))
    }

    // Split evenly between this many guests (1 = no split).
    fun ways(n: Int) {
        val s = _state.value as? PayUiState.Ready ?: return
        _state.value = s.copy(ways = n.coerceIn(1, 20), custom = null, tendered = null, error = null, perGuest = n > 1 || (s.perGuest && s.shares.isNotEmpty()))
    }

    // An amount typed in for this payment; null goes back to all that is left.
    fun custom(cents: Long?) {
        val s = _state.value as? PayUiState.Ready ?: return
        if (cents != null && (cents <= 0 || cents > s.remaining)) {
            _state.value = s.copy(error = "Type an amount up to ${Money.format(s.remaining)}")
            return
        }
        _state.value = s.copy(custom = cents?.takeIf { it < s.remaining }, ways = 1, tendered = null, error = null)
    }

    // Forgets the shares taken so far (the cashier gives the money back).
    fun dropShares() {
        val s = _state.value as? PayUiState.Ready ?: return
        _state.value = s.copy(shares = emptyList(), ways = 1, custom = null, tendered = null, error = null, notice = null, perGuest = false)
    }

    // Takes this payment. Cash: received >= the amount closes with change;
    // less is refused. Card, wallet, QR: the amount in one go, with an
    // optional reference. If something is still due afterwards, the share is
    // kept and the next one is asked for; when nothing is, the receipt goes out.
    fun pay() {
        val s = _state.value as? PayUiState.Ready ?: return
        if (paying) return
        if (s.lines.none { it.selected }) { _state.value = s.copy(error = "Tick at least one line"); return }
        val m = s.selected ?: run { _state.value = s.copy(error = "Pick a payment type"); return }
        val amount = s.now
        val input = if (m.kind == "cash") {
            val got = s.tendered ?: amount
            if (got < amount) { _state.value = s.copy(error = "Received is less than this payment's amount"); return }
            PayInput(m.id, amount, got, got - amount, null)
        } else {
            PayInput(m.id, amount, amount, 0, s.reference.ifBlank { null })
        }
        val shares = s.shares + Share(m.name, input)
        if (amount < s.remaining) {
            // more to come: keep the share, ask for the next
            _state.value = s.copy(
                shares = shares, ways = (s.ways - 1).coerceAtLeast(1), custom = null, tendered = null, reference = "", error = null,
                notice = "${m.name} ${Money.format(amount)} taken" + (if (input.change > 0) ", change ${Money.format(input.change)}" else "") +
                    ". ${Money.format(s.remaining - amount)} still to pay.",
            )
            return
        }
        record(s, shares)
    }

    private fun record(s: PayUiState.Ready, shares: List<Share>) = viewModelScope.launch {
        paying = true
        // the remark goes on the order first, so the receipt and the kitchen ticket carry it
        if (s.note.trim() != (tickets.activeTicket()?.note ?: "")) tickets.setNote(s.note.trim())
        val covered = s.lines.filter { it.selected }.map { it.id }
        // a zero total (fully discounted) is paid with no payment row
        val payments = shares.map { it.input }.filter { it.amount > 0 }
        val change = shares.sumOf { it.input.change }
        tickets.pay(payments, listOfNotNull(discount), 0, covered).fold(
            onSuccess = { receipt ->
                orderOps.afterPay(receipt, perGuest = s.perGuest && shares.size >= 2)
                val closed = tickets.activeTicket() == null
                if (closed) {
                    session.setPendingDiscount(null)
                    _state.value = PayUiState.Done(receipt, change)
                } else {
                    // an amount discount is given once, not on every guest's receipt
                    if (discount?.type == "amount") session.setPendingDiscount(null)
                    if (s.check != null) {
                        _checkPaid.value = true
                    } else {
                        val left = s.lines.count { !it.selected }
                        val paid = "Paid ${Money.format(receipt.total)}" + if (change > 0) ", change ${Money.format(change)}" else ""
                        _state.value = s.copy(shares = emptyList(), ways = 1, custom = null, perGuest = false)
                        reload("$paid. $left ${if (left == 1) "line" else "lines"} left to pay.")
                    }
                }
            },
            onFailure = { _state.value = s.copy(error = it.message) },
        )
        paying = false
    }
}
