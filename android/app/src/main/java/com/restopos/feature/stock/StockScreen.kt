package com.restopos.feature.stock

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.data.Approvals
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffSession
import com.restopos.core.ui.Gap
import com.restopos.core.ui.ScreenHead
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import javax.inject.Inject

// The five things a shop does about its stock on the tablet. permission: what
// someone needs to use the tab (none: whoever has opened Stock). what: the
// words of "You are not allowed to ...". about: what the tab is for, said to
// someone who may not use it.
enum class StockTab(val label: String, val permission: String?, val what: String, val about: String) {
    Deliveries("Deliveries", "stock.receive", "receive deliveries", "What arrives from a supplier is received here, with or without an order: the stock goes up and the product costs what was paid."),
    Orders("Orders", "stock.receive", "order from suppliers", "Orders to suppliers are written and sent here, and what arrives is received against them."),
    Counts("Counts", "stock.count", "count stock", "The shelves are counted here: the whole shop, or one category, supplier or brand."),
    History("History", "stock.view", "see the stock history", "Every movement of stock is listed here: what was sold, received, counted and corrected."),
    Suppliers("Suppliers", null, "", ""),
}

// Which tab is open, and who may use it. Someone who may not can be let in by
// someone who may, with their PIN: their word then goes with what is saved
// from that tab, and is forgotten when the screen is left or when someone
// else signs in at the till.
@HiltViewModel
class StockViewModel @Inject constructor(
    private val staff: StaffSession,
    private val approvals: Approvals,
) : ViewModel() {
    val tab = MutableStateFlow(StockTab.Deliveries)
    val current: StateFlow<StaffMember?> = staff.current
    private val _words = MutableStateFlow<Map<String, StaffMember>>(emptyMap())
    // permission -> who gave their word for it
    val words: StateFlow<Map<String, StaffMember>> = _words

    init {
        viewModelScope.launch { staff.current.drop(1).collect { _words.value = emptyMap() } }
    }

    fun open(t: StockTab) { tab.value = t }
    fun may(t: StockTab, words: Map<String, StaffMember>): Boolean = t.permission == null || staff.can(t.permission) || words.containsKey(t.permission)
    fun unlock(t: StockTab) {
        val p = t.permission ?: return
        approvals.ask(p, t.what) { who -> _words.value = _words.value + (p to who) }
    }
    // Who gave their word for a permission, when the person signed in does not hold it: sent as approved_by.
    fun approver(permission: String): StaffMember? = _words.value[permission]
    // Rupees of cost are for whoever may see costs, and for whoever orders and receives (they type them).
    fun costs(words: Map<String, StaffMember>): Boolean = staff.can("costs.view") || staff.can("stock.receive") || words.containsKey("stock.receive")
    fun leave() { _words.value = emptyMap() }

    // An order that is waiting, handed from Orders to Deliveries to be received: taken there once.
    val receiving = MutableStateFlow<com.restopos.core.database.PurchaseOrderEntity?>(null)
    fun receive(order: com.restopos.core.database.PurchaseOrderEntity) { receiving.value = order; tab.value = StockTab.Deliveries }
    fun taken() { receiving.value = null }
}

// Stock: one screen, five tabs. A shop's side menu opens it.
@Composable
fun StockScreen(vm: StockViewModel, serviceLine: String, onLabels: ((LabelsFor) -> Unit)? = null) {
    val tab by vm.tab.collectAsState()
    val words by vm.words.collectAsState()
    val who by vm.current.collectAsState()
    // a manager's word is for while the screen is open, not for whoever comes to the till next
    DisposableEffect(Unit) { onDispose { vm.leave() } }

    Column(Modifier.fillMaxSize().padding(start = 24.dp, end = 24.dp, top = 20.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            ScreenHead(serviceLine, "Stock")
            Gap()
            Seg(StockTab.entries.map { t -> SegOption(t.label, t == tab) { vm.open(t) } }, well = V.Panel)
        }
        // read again when someone else signs in: what they may do is theirs
        val allowed = who.let { vm.may(tab, words) }
        Box(Modifier.fillMaxSize()) {
            if (!allowed) Locked(tab) { vm.unlock(tab) }
            else when (tab) {
                StockTab.Suppliers -> { val s: SuppliersViewModel = hiltViewModel(); SuppliersTab(s) }
                StockTab.History -> { val h: HistoryViewModel = hiltViewModel(); HistoryTab(h) }
                StockTab.Orders -> { val o: OrdersViewModel = hiltViewModel(); OrdersTab(o, vm.approver("stock.receive"), vm.costs(words)) { order -> vm.receive(order) } }
                StockTab.Deliveries -> {
                    val d: ReceiveViewModel = hiltViewModel()
                    val order by vm.receiving.collectAsState()
                    DeliveriesTab(d, vm.approver("stock.receive"), vm.costs(words), order, onTaken = { vm.taken() }, onLabels = onLabels)
                }
                else -> Soon(tab)
            }
        }
    }
}

// A tab for someone who may not use it: what it is for, and the way in.
@Composable
private fun Locked(tab: StockTab, onAsk: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically)) {
        T(tab.label, 26.sp, 700, spacing = (-0.6).sp)
        T(tab.about, 15.sp, 500, V.Text2, Modifier.widthIn(max = 520.dp), lines = 4, align = TextAlign.Center)
        T("You are not allowed to ${tab.what}. Someone who is can open this with their PIN.", 15.sp, 500, V.Text2, Modifier.widthIn(max = 520.dp), lines = 3, align = TextAlign.Center)
        VBtn("Ask a manager", bg = V.Blue, fg = Color.White, height = 56.dp, pad = 24.dp) { onAsk() }
    }
}

// Counts is the next build: until then the tab says so.
@Composable
private fun Soon(tab: StockTab) {
    Column(Modifier.fillMaxWidth().padding(40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        T(tab.label, 22.sp, 700, spacing = (-0.4).sp)
        T(tab.about, 15.sp, 500, V.Text2, Modifier.widthIn(max = 520.dp), lines = 4, align = TextAlign.Center)
        T("Coming with the next build.", 15.sp, 600, V.Text3)
    }
}
