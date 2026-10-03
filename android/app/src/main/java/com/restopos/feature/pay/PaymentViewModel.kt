package com.restopos.feature.pay

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
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

// Payment (spec 7.5): cash quick amounts + tendered/change; wallet/QR take an
// optional reference (manual record in v1). One receipt pays the amount due
// in full; splitting a bill by item needs line selection, which is not built.
sealed interface PayUiState {
    data object Loading : PayUiState
    data class Ready(
        val total: Long,
        val remaining: Long,
        val methods: List<PaymentTypeEntity>,
        val selected: PaymentTypeEntity?,
        val tenderedRs: String,
        val reference: String,
        val error: String?,
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
    private var discount: com.restopos.core.data.DiscountPick? = null

    init { reload() }

    fun reload() = viewModelScope.launch {
        val t = tickets.activeTicket()
        if (t == null) return@launch
        val lines = db.tickets().lines(t.id).first().filter { it.voided_at == null }
        val calcLines = lines.map { l ->
            val taxes = db.catalog().lineTaxes(l.id)
            com.restopos.core.data.Calc.Line(
                com.restopos.core.data.Calc.lineAmount(l.unit_price, l.qty) + db.tickets().modSum(l.id),
                taxes.map { com.restopos.core.data.Calc.TaxRate(it.rate_bp, it.type) },
            )
        }
        discount = session.pendingDiscount()?.let { id ->
            db.catalog().discount(id)?.let {
                com.restopos.core.data.DiscountPick(it.id, it.type, it.value, it.name)
            }
        }
        val totals = com.restopos.core.data.Calc.totals(
            calcLines,
            listOfNotNull(discount?.let {
                com.restopos.core.data.Calc.Discount(if (it.type == "percent") it.value.toInt() else null, it.value)
            }),
        )
        val prior = db.receipts().paidForTicket(t.id)
        val methods = db.catalog().paymentTypes().first()
        val cur = _state.value as? PayUiState.Ready
        _state.value = PayUiState.Ready(
            totals.total, totals.total - prior, methods,
            cur?.selected ?: methods.firstOrNull(), cur?.tenderedRs ?: "", cur?.reference ?: "", null,
        )
    }

    fun select(m: PaymentTypeEntity) {
        val s = _state.value as? PayUiState.Ready ?: return
        _state.value = s.copy(selected = m, tenderedRs = "", reference = "")
    }

    fun tendered(v: String) {
        val s = _state.value as? PayUiState.Ready ?: return
        _state.value = s.copy(tenderedRs = v.filter { it.isDigit() }.take(6))
    }

    fun reference(v: String) {
        val s = _state.value as? PayUiState.Ready ?: return
        _state.value = s.copy(reference = v.take(64))
    }

    // Cash: tendered >= the amount due closes with change. Less than that is
    // refused: a part payment would reach the server as a short receipt.
    fun takeCash() {
        val s = _state.value as? PayUiState.Ready ?: return
        val tend = (s.tenderedRs.toLongOrNull() ?: (s.remaining + 99) / 100) * 100
        if (s.remaining <= 0 || tend <= 0) { _state.value = s.copy(error = "Nothing to pay"); return }
        if (tend >= s.remaining) payChunk(s.remaining, tend, tend - s.remaining, s, null)
        else _state.value = s.copy(error = "Tendered is less than the amount due")
    }

    // Card/wallet/QR: full remaining in one chunk with optional reference.
    fun takeMethod() {
        val s = _state.value as? PayUiState.Ready ?: return
        val m = s.selected ?: return
        if (s.remaining <= 0) { _state.value = s.copy(error = "Nothing to pay"); return }
        payChunk(s.remaining, s.remaining, 0, s, s.reference.ifBlank { null })
    }

    private fun payChunk(amount: Long, tendered: Long, change: Long, s: PayUiState.Ready, ref: String?) =
        viewModelScope.launch {
            val m = s.selected ?: return@launch
            tickets.pay(
                listOf(PayInput(m.id, amount, tendered, change, ref)),
                listOfNotNull(discount),
                0,
            ).fold(
                onSuccess = { receipt ->
                    if (change > 0 || amount >= s.remaining) {
                        session.setPendingDiscount(null)
                        _state.value = PayUiState.Done(receipt, change)
                    } else reload()
                },
                onFailure = { _state.value = s.copy(error = it.message) },
            )
        }
}
