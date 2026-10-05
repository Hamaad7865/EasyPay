package com.restopos.feature.menu

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.Approvals
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.L
import com.restopos.core.ui.Pos
import com.restopos.core.ui.ScreenHead
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.Toggle
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.panel
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

data class MenuRow(val item: ItemEntity, val category: CategoryEntity?, val index: Int, val station: String, val options: String)

// The menu as the floor needs it during service: what there is, where it is
// made, whether it can still be sold, and what it costs. A price can be
// changed here by someone allowed to edit the menu; the rest of an item is
// the back office's.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class MenuViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val service: ServiceRepository,
    private val approvals: Approvals,
) : ViewModel() {
    val cat = MutableStateFlow<String?>(null)
    val query = MutableStateFlow("")
    val cats: StateFlow<List<CategoryEntity>> = db.catalog().categories().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val total: StateFlow<Int> = db.service().itemCount().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)
    val soldOut: StateFlow<Int> = db.service().soldOutCount().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    val rows: StateFlow<List<MenuRow>> = combine(cat, query) { c, q -> c to q.trim() }
        .flatMapLatest { (c, q) -> combine(db.service().items(c, q), db.service().itemGroups(), cats) { items, groups, cats -> Triple(items, groups, cats) } }
        .map { (items, groups, cats) ->
            val printers = (session.storeId()?.let { db.ops().printers(it) } ?: emptyList()).filter { !it.is_receipt }.associate { it.id to it.name }
            val byId = cats.associateBy { it.id }
            val index = cats.mapIndexed { i, c -> c.id to i }.toMap()
            val options = groups.associate { it.item_id to (it.names ?: "") }
            val stationOf = cats.associate { c ->
                c.id to runCatching { Json.parseToJsonElement(c.printer_ids).jsonArray.mapNotNull { printers[it.jsonPrimitive.content] } }.getOrDefault(emptyList()).joinToString(", ")
            }
            items.map { i -> MenuRow(i, byId[i.category_id], index[i.category_id] ?: 0, stationOf[i.category_id].orEmpty().ifEmpty { "—" }, options[i.id].orEmpty().ifEmpty { "—" }) }
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    // The item whose price is being changed, or none.
    val pricing = MutableStateFlow<ItemEntity?>(null)

    // A new price for an item, as typed ("120", "99.50"). Someone who may not
    // change prices asks someone who may; the sheet closes while they do.
    fun setPrice(item: ItemEntity, typed: String, by: StaffMember? = null) {
        val price = Money.parseRs(typed)
        if (price == null) { Toaster.say("Type the price as a number, for example 120 or 99.50"); return }
        viewModelScope.launch {
            val out = service.setPrice(item.id, price, by)
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                pricing.value = null
                approvals.ask(need.permission, need.what) { approver -> setPrice(item, typed, approver) }
            } else out.fold(
                { pricing.value = null; Toaster.say(if (price == item.price) "${item.name} stays at ${Money.format(price)}" else "${item.name} is now ${Money.format(price)}") },
                { Toaster.say(it.message) },
            )
        }
    }

    // Sold out, or back on sale. Someone who may not asks someone who may.
    fun toggle(item: ItemEntity, by: StaffMember? = null) {
        viewModelScope.launch {
            val on = !item.is_available
            val out = service.setAvailable(item.id, on, by)
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) approvals.ask(need.permission, need.what) { approver -> toggle(item, approver) }
            else out.fold({ Toaster.say(item.name + if (on) " back on sale" else " marked sold out") }, { Toaster.say(it.message) })
        }
    }
}

private val CAT_COLORS = listOf(0xFFB9521C, 0xFF2459C9, 0xFFB83A3A, 0xFF8F6A0E, 0xFFA8366F, 0xFF117785, 0xFF6243C8, 0xFF74513A).map { Color(it) }
private fun colorOf(c: CategoryEntity?, index: Int): Color = Pos.css(c?.color, CAT_COLORS[Math.floorMod(index, CAT_COLORS.size)])

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MenuStockScreen(vm: MenuViewModel) {
    val cats by vm.cats.collectAsState()
    val cat by vm.cat.collectAsState()
    val q by vm.query.collectAsState()
    val rows by vm.rows.collectAsState()
    val total by vm.total.collectAsState()
    val soldOut by vm.soldOut.collectAsState()
    val pricing by vm.pricing.collectAsState()

    Column(Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            ScreenHead("$total items · $soldOut sold out", L.menu, Modifier.weight(1f))
            Field(q, { vm.query.value = it.take(40) }, "Find an item", Modifier.width(340.dp), height = 52.dp, bg = V.Panel, size = 16.sp, leading = { VIcon(VI.Search, 20.dp, V.Text2) })
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            (listOf<CategoryEntity?>(null) + cats).forEachIndexed { i, c ->
                val on = c?.id == cat
                Row(
                    Modifier.height(44.dp).clip(RoundedCornerShape(22.dp)).background(if (on) V.On else V.Panel).border(1.dp, if (on) V.On else V.Stroke, RoundedCornerShape(22.dp))
                        .clickable { vm.cat.value = c?.id }.padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(if (c == null) (if (on) V.OnText else V.Text) else colorOf(c, i - 1)))
                    T(c?.name ?: "All items", 14.sp, 700, if (on) V.OnText else V.Text)
                }
            }
        }
        Column(Modifier.weight(1f).fillMaxWidth().panel()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Caps("Item", V.Text2, Modifier.weight(1.6f))
                Caps("Category", V.Text2, Modifier.weight(1f))
                Caps("Station", V.Text2, Modifier.weight(0.8f))
                Caps("Options", V.Text2, Modifier.weight(1f))
                Box(Modifier.width(130.dp), contentAlignment = Alignment.CenterEnd) { Caps("Price · tap to change", V.Text2) }
                Caps("Availability", V.Text2, Modifier.width(170.dp))
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
            LazyColumn(Modifier.fillMaxSize()) {
                if (rows.isEmpty()) item { T("No items match.", 15.sp, 500, V.Text2, Modifier.padding(48.dp)) }
                items(rows, key = { it.item.id }) { r ->
                    val on = r.item.is_available
                    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        T(r.item.name, 15.sp, 700, modifier = Modifier.weight(1.6f), lines = 2)
                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Box(Modifier.size(8.dp).clip(CircleShape).background(colorOf(r.category, r.index)))
                            T(r.category?.name ?: "—", 15.sp, 500, V.Dim)
                        }
                        T(r.station, 15.sp, 500, V.Dim, Modifier.weight(0.8f))
                        T(r.options, 14.sp, 500, V.Text2, Modifier.weight(1f), lines = 2)
                        // the price is a key: tapping it changes what the item costs
                        Box(
                            Modifier.width(130.dp).height(44.dp).clip(RoundedCornerShape(10.dp)).background(V.Key2).border(1.dp, V.Stroke, RoundedCornerShape(10.dp))
                                .clickable { vm.pricing.value = r.item }.padding(horizontal = 12.dp),
                            contentAlignment = Alignment.CenterEnd,
                        ) { T(Money.format(r.item.price), 15.sp, 700) }
                        Row(
                            Modifier.width(170.dp).height(48.dp).clip(RoundedCornerShape(12.dp)).clickable { vm.toggle(r.item) },
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Toggle(on)
                            T(if (on) "Available" else "Sold out", 14.sp, 700, if (on) V.GreenText else V.RedText)
                        }
                    }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                }
            }
        }
    }

    pricing?.let { item ->
        // what it costs now, as a number to type over: "120" or "99.50"
        var typed by remember(item.id) { mutableStateOf(if (item.price % 100 == 0L) (item.price / 100).toString() else "%d.%02d".format(item.price / 100, item.price % 100)) }
        Sheet(onDismiss = { vm.pricing.value = null }, width = 520.dp) {
            SheetHead("Price of ${item.name}", "Now ${Money.format(item.price)}. Orders already open keep the price they were rung up at.") { vm.pricing.value = null }
            Field(
                typed, { v -> typed = v.filter { it.isDigit() || it == '.' }.take(9) }, "New price", Modifier.fillMaxWidth(), height = 60.dp, number = true, size = 22.sp,
                leading = { T("Rs", 18.sp, 700, V.Text2) }, onDone = { vm.setPrice(item, typed) },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Cancel", Modifier.weight(1f), height = 60.dp) { vm.pricing.value = null }
                VBtn("Save price", Modifier.weight(1f), V.Blue, Color.White, 60.dp, weight = 800) { vm.setPrice(item, typed) }
            }
        }
    }
}
