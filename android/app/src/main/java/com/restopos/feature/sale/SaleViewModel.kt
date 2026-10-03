package com.restopos.feature.sale

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.paging.PagingData
import androidx.paging.cachedIn
import com.restopos.core.data.Calc
import com.restopos.core.data.CatalogRepository
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.ModPick
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ModifierEntity
import com.restopos.core.database.ModifierGroupEntity
import com.restopos.core.database.TicketEntity
import com.restopos.core.database.TicketLineEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// Phase 1: grid rendered from Room. Phase 2: live ticket panel + totals.
// Ticket building is Phase 2; tapping a tile adds it (sheet first when the
// item has modifier groups or variants).
sealed interface SaleUiState {
    data class Ready(val categories: List<CategoryEntity>, val selectedCat: String?) : SaleUiState
}

sealed interface SaleAction {
    data class SelectCategory(val id: String?) : SaleAction
    data class Search(val query: String) : SaleAction
    data class TapItem(val item: ItemEntity) : SaleAction
    data class ConfirmMods(val qty: Int, val picks: List<ModPick>, val note: String) : SaleAction
    data class SetQty(val lineId: String, val qty: Int) : SaleAction
    data class VoidLine(val lineId: String, val reason: String) : SaleAction
    data object NewTicket : SaleAction
    data object DismissSheet : SaleAction
}

data class LineUi(val line: TicketLineEntity, val mods: String)
data class SheetData(
    val item: ItemEntity,
    val groups: List<ModifierGroupEntity>,
    val mods: List<ModifierEntity>,
)

@HiltViewModel
class SaleViewModel @Inject constructor(
    private val repo: CatalogRepository,
    private val tickets: TicketRepository,
    private val db: TillDatabase,
    private val session: SessionStore,
) : ViewModel() {
    private val cat = MutableStateFlow<String?>(null)
    private val query = MutableStateFlow("")
    private val _toast = MutableStateFlow<String?>(null)
    val toast: StateFlow<String?> = _toast

    private val _ticket = MutableStateFlow<TicketEntity?>(null)
    val ticket: StateFlow<TicketEntity?> = _ticket

    private val _lines = MutableStateFlow<List<LineUi>>(emptyList())
    val lines: StateFlow<List<LineUi>> = _lines

    private val _totals = MutableStateFlow(Calc.Totals(0, 0, 0, 0))
    val totals: StateFlow<Calc.Totals> = _totals

    private val _discounts = MutableStateFlow<List<DiscountEntity>>(emptyList())
    val discounts: StateFlow<List<DiscountEntity>> = _discounts

    private val _discount = MutableStateFlow<DiscountPick?>(null)
    val discount: StateFlow<DiscountPick?> = _discount

    private val _sheet = MutableStateFlow<SheetData?>(null)
    val sheet: StateFlow<SheetData?> = _sheet

    // Sync status for the bar under the title: signed out, waiting, rejected.
    val needsSignIn: StateFlow<Boolean> = session.needsSignIn
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    val pending: StateFlow<Long> = db.outbox().pendingCountFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)
    val rejected: StateFlow<Long> = db.outbox().deadCountFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    val state: Flow<SaleUiState> = combine(repo.categories(), cat) { cats, sel -> SaleUiState.Ready(cats, sel) }

    @OptIn(ExperimentalCoroutinesApi::class)
    val items: Flow<PagingData<ItemEntity>> = combine(cat, query) { c, q -> c to q }
        .flatMapLatest { (c, q) -> repo.items(c, q) }
        .cachedIn(viewModelScope)

    init { refresh() }

    fun refresh() = viewModelScope.launch {
        _ticket.value = tickets.activeTicket()
        _discounts.value = db.catalog().discounts()
        reloadLines()
    }

    private suspend fun reloadLines() {
        val t = _ticket.value
        if (t == null) { _lines.value = emptyList(); _totals.value = Calc.Totals(0, 0, 0, 0); return }
        val dao = db.tickets()
        val rows = dao.lines(t.id).first()
        _lines.value = rows.map { LineUi(it, dao.modText(it.id) ?: "") }
        val calcLines = rows.filter { it.voided_at == null && !it.paid }.map { l ->
            val taxes = db.catalog().lineTaxes(l.id)
            val mods = dao.modSum(l.id)
            Calc.Line(Calc.lineAmount(l.unit_price, l.qty) + mods, taxes.map { Calc.TaxRate(it.rate_bp, it.type) })
        }
        val d = _discount.value
        _totals.value = Calc.totals(calcLines, listOfNotNull(d?.let {
            Calc.Discount(if (it.type == "percent") it.value.toInt() else null, it.value)
        }))
    }

    fun onAction(a: SaleAction) = viewModelScope.launch {
        when (a) {
            is SaleAction.SelectCategory -> cat.value = a.id
            is SaleAction.Search -> query.value = a.query
            is SaleAction.TapItem -> {
                val groups = db.catalog().groupsForItem(a.item.id)
                if (groups.isEmpty()) {
                    tickets.addItem(a.item.id, 1000, emptyList(), null)
                        .onFailure { _toast.value = it.message }
                    refresh()
                } else {
                    _sheet.value = SheetData(a.item, groups, db.catalog().modifiersForItem(a.item.id))
                }
            }
            is SaleAction.ConfirmMods -> {
                val item = _sheet.value?.item ?: return@launch
                _sheet.value = null
                tickets.addItem(item.id, a.qty * 1000, a.picks, a.note.ifBlank { null })
                    .onFailure { _toast.value = it.message }
                refresh()
            }
            is SaleAction.SetQty -> {
                tickets.setQty(a.lineId, a.qty * 1000, "quantity change")
                    .onFailure { _toast.value = it.message }
                refresh()
            }
            is SaleAction.VoidLine -> {
                tickets.voidLine(a.lineId, a.reason)
                    .onFailure { _toast.value = it.message }
                refresh()
            }
            is SaleAction.NewTicket -> {
                tickets.newTicket(); _discount.value = null; refresh()
            }
            is SaleAction.DismissSheet -> _sheet.value = null
        }
    }

    fun setDiscount(d: DiscountPick?) {
        _discount.value = d
        viewModelScope.launch {
            session.setPendingDiscount(d?.discountId)
            reloadLines()
        }
    }
    fun toastShown() { _toast.value = null }
}
