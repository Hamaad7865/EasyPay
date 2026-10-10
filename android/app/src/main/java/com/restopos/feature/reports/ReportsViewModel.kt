package com.restopos.feature.reports

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.data.Approvals
import com.restopos.core.data.CashOps
import com.restopos.core.data.Reports
import com.restopos.core.data.ReportsRepository
import com.restopos.core.data.StaffSession
import com.restopos.core.print.ZDoc
import com.restopos.core.ui.Toaster
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId
import javax.inject.Inject

// The nine reports, named and ordered as the owner's picture of another till lists them.
enum class Report(val label: String) {
    Summary("Sales Summary"), Analysis("Sales Analysis"), Items("Item Sales Rank"), Hourly("Hourly Sales Report"),
    Transactions("Transaction Detail"), Prices("Price Change"), Resettlement("Resettlement"), Shifts("Shift Record"), Tax("Tax Report"),
}

// How Sales Analysis cuts the period's sales.
enum class Cutting(val label: String) { Category("By category"), Staff("By staff"), Order("By order type") }

// Everything a period's reports are made of, loaded once for all nine.
class ReportData(
    val span: Reports.Span, val figures: CashOps.Figures?, val sales: List<Reports.Sale>, val days: List<ReportsRepository.ShiftRow>,
    val decimals: Int,
    // what the tablet wrote down itself: prices changed, payments corrected, and since when it has
    val prices: List<Reports.PriceChange> = emptyList(), val corrected: List<Reports.Corrected> = emptyList(), val logSince: Long? = null,
)

// A closed day opened from Shift Record: its row and its closing figures.
class OpenDay(val row: ReportsRepository.ShiftRow, val doc: ZDoc)

// Behind the Reports screen: which report is open, of which days, and the
// period's receipts and figures, read again whenever the days change. The
// reports are of this till and of what this tablet holds.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class ReportsViewModel @Inject constructor(
    private val repo: ReportsRepository,
    private val staff: StaffSession,
    private val approvals: Approvals,
) : ViewModel() {
    private val zone: ZoneId = ZoneId.systemDefault()
    val report = MutableStateFlow(Report.Summary)
    val pick = MutableStateFlow(Reports.Pick.Today)
    val from = MutableStateFlow(LocalDate.now(zone))
    val to = MutableStateFlow(LocalDate.now(zone))
    val cutting = MutableStateFlow(Cutting.Category)
    val byQty = MutableStateFlow(false)
    val query = MutableStateFlow("")
    // read again when the screen is opened: a sale rung up since is in it
    private val tick = MutableStateFlow(0)

    val data: StateFlow<ReportData?> = combine(pick, from, to, tick) { p, a, b, _ -> Triple(p, a, b) }
        .mapLatest { (p, a, b) ->
            val span = Reports.span(p, LocalDate.now(zone), zone, a, b)
            ReportData(span, repo.figures(span), repo.sales(span), repo.days(span), repo.decimals(), repo.priceChanges(span), repo.corrected(span), repo.logSince())
        }
        .flowOn(Dispatchers.IO)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    private val _since = MutableStateFlow<Long?>(null)
    // when this till rang up its first receipt: its reports know nothing of before
    val since: StateFlow<Long?> = _since
    private val _retail = MutableStateFlow(false)
    val retail: StateFlow<Boolean> = _retail

    // someone who may not see the figures can be shown them by someone who may, while the screen is open
    private val shown = MutableStateFlow(false)
    val allowed: StateFlow<Boolean> = combine(staff.current, shown) { _, s -> s || staff.can(PERMISSION) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), staff.can(PERMISSION))
    fun unlock() = approvals.ask(PERMISSION, "see the reports") { shown.value = true }
    fun leave() { shown.value = false }

    init {
        viewModelScope.launch { staff.current.drop(1).collect { shown.value = false } }
    }

    fun refresh() {
        tick.value += 1
        viewModelScope.launch {
            _since.value = repo.since()
            _retail.value = repo.retail()
        }
    }

    fun open(r: Report) { report.value = r }
    fun pick(p: Reports.Pick) { pick.value = p }
    fun dates(a: LocalDate, b: LocalDate) {
        val today = LocalDate.now(zone)
        from.value = minOf(a, today); to.value = minOf(b, today); pick.value = Reports.Pick.Custom
    }
    fun zone(): ZoneId = zone

    // ---- a closed day, opened from Shift Record ----
    private val _day = MutableStateFlow<OpenDay?>(null)
    val day: StateFlow<OpenDay?> = _day
    fun openDay(row: ReportsRepository.ShiftRow) = viewModelScope.launch { _day.value = OpenDay(row, repo.dayDoc(row.close)) }
    fun closeDay() { _day.value = null }
    fun printDay() = viewModelScope.launch {
        val d = _day.value ?: return@launch
        Toaster.say(repo.printDay(d.row.close).fold({ "Day closing No. ${d.row.close.number} sent to the printer." }, { it.message ?: "It could not be printed." }))
    }

    // ---- on paper ----
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy
    fun print() = viewModelScope.launch {
        val d = data.value ?: return@launch
        if (_busy.value) return@launch
        _busy.value = true
        val r = report.value
        val out = repo.print(r.label, d.span, printed(r, d, cutting.value, byQty.value, _retail.value, zone))
        _busy.value = false
        Toaster.say(out.fold({ "${r.label} sent to the printer." }, { it.message ?: "It could not be printed." }))
    }

    private companion object { const val PERMISSION = "shift.view_report" }
}
