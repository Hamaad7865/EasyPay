package com.restopos.feature.pay

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.tableLabel
import com.restopos.core.data.Calc
import com.restopos.core.data.DiscountPick
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
// the other types take an optional reference (manual record in v1). A bill is split by item: tick the
// lines one guest pays for, take the payment, and the rest stays on the order
// for the next receipt. Each receipt pays its lines in full (the server would
// store a part payment, but flagged for review).
data class PayLine(val id: String, val qty: Int, val name: String, val amount: Long, val selected: Boolean)

sealed interface PayUiState {
    data object Loading : PayUiState
    data class Ready(
        val title: String, // the order's name: its tab name, else its table
        val lines: List<PayLine>, // unpaid lines; the receipt covers the ticked ones
        val due: Long, // total of the ticked lines, discount included
        val methods: List<PaymentTypeEntity>,
        val selected: PaymentTypeEntity?,
        val tendered: Long?, // cash received, in cents; null = exactly the amount due
        val reference: String,
        val error: String?,
        val notice: String? = null,
    ) : PayUiState

    data class Done(val receipt: ReceiptEntity, val change: Long) : PayUiState
}

@HiltViewModel
class PaymentViewModel @Inject constructor(
    private val tickets: TicketRepository,
    private val db: TillDatabase,
    private val session: SessionStore,
) : ViewModel() {
    private val _state = MutableStateFlow<PayUiState>(PayUiState.Loading)
    val state: StateFlow<PayUiState> = _state
    private var discount: DiscountPick? = null
    private var calc: Map<String, Calc.Line> = emptyMap()
    private var paying = false // a second tap on Pay while the first is being recorded does nothing

    init { reload(notice = null) }

    private fun dueFor(ids: Set<String>): Long {
        val picked = calc.filterKeys { ids.contains(it) }.values.toList()
        val d = discount
        return Calc.totals(picked, listOfNotNull(d?.let { Calc.Discount(if (it.type == "percent") it.value.toInt() else null, it.value) })).total
    }

    // Loads what is still unpaid. Every line starts ticked: paying the whole
    // bill is the common case, splitting is the exception.
    private fun reload(notice: String?) = viewModelScope.launch {
        val t = tickets.activeTicket() ?: return@launch
        val unpaid = db.tickets().lines(t.id).first().filter { it.voided_at == null && !it.paid }
        val amounts = HashMap<String, Long>()
        calc = unpaid.associate { l ->
            val base = Calc.lineAmount(l.unit_price, l.qty) + db.tickets().modSum(l.id)
            amounts[l.id] = base
            l.id to Calc.Line(base, db.catalog().lineTaxes(l.id).map { Calc.TaxRate(it.rate_bp, it.type) })
        }
        discount = session.pendingDiscount()?.let { id ->
            db.catalog().discount(id)?.let { DiscountPick(it.id, it.type, it.value, it.name) }
        }
        val methods = db.catalog().paymentTypes().first()
        val cur = _state.value as? PayUiState.Ready
        val lines = unpaid.map { PayLine(it.id, it.qty, it.name_snapshot, amounts[it.id] ?: 0, true) }
        val title = t.name ?: t.table_id?.let { db.tables().table(it)?.name }?.let { tableLabel(it) } ?: "Direct sale"
        _state.value = PayUiState.Ready(
            title, lines, dueFor(lines.map { it.id }.toSet()), methods,
            cur?.selected ?: methods.firstOrNull(), null, "", null, notice,
        )
    }

    fun toggle(lineId: String) {
        val s = _state.value as? PayUiState.Ready ?: return
        val lines = s.lines.map { if (it.id == lineId) it.copy(selected = !it.selected) else it }
        _state.value = s.copy(lines = lines, due = dueFor(lines.filter { it.selected }.map { it.id }.toSet()), tendered = null, error = null)
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

    // Cash: received >= the amount due closes with change. Less than that is
    // refused: a part payment would reach the server as a short receipt.
    // Card/wallet/QR: the amount due in one go, with an optional reference.
    fun pay() {
        val s = _state.value as? PayUiState.Ready ?: return
        if (paying) return
        if (s.lines.none { it.selected }) { _state.value = s.copy(error = "Tick at least one line"); return }
        val m = s.selected ?: run { _state.value = s.copy(error = "Pick a payment type"); return }
        if (m.kind == "cash") {
            val got = s.tendered ?: s.due
            if (got >= s.due) payChunk(s.due, got, got - s.due, s, null)
            else _state.value = s.copy(error = "Received is less than the amount due")
        } else {
            payChunk(s.due, s.due, 0, s, s.reference.ifBlank { null })
        }
    }

    private fun payChunk(amount: Long, tendered: Long, change: Long, s: PayUiState.Ready, ref: String?) =
        viewModelScope.launch {
            val m = s.selected ?: return@launch
            paying = true
            val covered = s.lines.filter { it.selected }.map { it.id }
            // a zero total (fully discounted) is paid with no payment row
            val payments = if (amount > 0) listOf(PayInput(m.id, amount, tendered, change, ref)) else emptyList()
            tickets.pay(payments, listOfNotNull(discount), 0, covered).fold(
                onSuccess = { receipt ->
                    val closed = tickets.activeTicket() == null
                    if (closed) {
                        session.setPendingDiscount(null)
                        _state.value = PayUiState.Done(receipt, change)
                    } else {
                        // an amount discount is given once, not on every guest's receipt
                        if (discount?.type == "amount") session.setPendingDiscount(null)
                        val left = s.lines.count { !it.selected }
                        val paid = "Paid ${Money.format(amount)}" + if (change > 0) ", change ${Money.format(change)}" else ""
                        reload("$paid. $left ${if (left == 1) "line" else "lines"} left to pay.")
                    }
                },
                onFailure = { _state.value = s.copy(error = it.message) },
            )
            paying = false
        }
}
