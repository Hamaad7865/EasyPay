package com.restopos.feature.bookings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.BookingEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Chip
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.L
import com.restopos.core.ui.ScreenHead
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.Stepper
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.panel
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale
import javax.inject.Inject

// A booking with the table it is held on, and whether that table can take it now.
data class BookingRow(val booking: BookingEntity, val table: TableEntity?, val tableFree: Boolean)
data class BookingsUi(val rows: List<BookingRow> = emptyList(), val areas: List<String> = emptyList())

@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class BookingsViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val service: ServiceRepository,
    private val tickets: TicketRepository,
) : ViewModel() {
    val ui: StateFlow<BookingsUi> = flow { emit(session.storeId()) }.flatMapLatest { store ->
        if (store == null) flowOf(BookingsUi())
        else combine(service.bookingsToday(store), db.tables().tables(store), db.tickets().openTickets(store)) { bookings, tables, open ->
            val byId = tables.associateBy { it.id }
            val taken = open.mapNotNull { it.table_id }.toSet()
            BookingsUi(bookings.map { b -> BookingRow(b, b.table_id?.let { byId[it] }, b.table_id != null && !taken.contains(b.table_id)) }, tables.map { it.area }.distinct())
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), BookingsUi())

    fun confirm(b: BookingEntity) = viewModelScope.launch {
        service.changeBooking(b.id) { it.copy(status = "confirmed") }.fold({ Toaster.say("${b.name} is confirmed") }, { Toaster.say(it.message) })
    }

    // The table held for a party that did not come is free again.
    fun noShow(b: BookingEntity) = viewModelScope.launch {
        service.changeBooking(b.id) { it.copy(status = "noshow", table_id = null) }.fold({ Toaster.say("${b.name} marked as no-show") }, { Toaster.say(it.message) })
    }

    fun cancel(b: BookingEntity) = viewModelScope.launch {
        service.changeBooking(b.id) { it.copy(status = "cancelled", table_id = null) }.fold({ Toaster.say("${b.name}'s booking is cancelled") }, { Toaster.say(it.message) })
    }

    // The party has arrived: their table is seated and its order opens.
    fun seat(row: BookingRow, then: () -> Unit) = viewModelScope.launch {
        val table = row.table ?: return@launch
        tickets.seat(table.id, row.booking.size).fold(
            onSuccess = { t ->
                service.changeBooking(row.booking.id) { it.copy(status = "seated", ticket_id = t.id) }
                then()
            },
            onFailure = { Toaster.say(it.message) },
        )
    }

    fun add(day: Int, hour: Int, minute: Int, name: String, size: Int, phone: String, area: String?, tags: String, then: () -> Unit) = viewModelScope.launch {
        val at = LocalDate.now().plusDays(day.toLong()).atTime(LocalTime.of(hour, minute)).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        service.newBooking(at, name, size, phone, area, tags).fold(
            onSuccess = { Toaster.say("Booked · ${it.name} · ${it.size} guests" + if (day > 0) " · it shows here on the day" else ""); then() },
            onFailure = { Toaster.say(it.message) },
        )
    }
}

private val HM = SimpleDateFormat("HH:mm", Locale.US)
private val COLS = listOf(64.dp, 0.dp, 52.dp, 0.dp, 0.dp, 108.dp, 330.dp)

// Today's bookings: who is coming, when, how many, and where they will sit.
@Composable
fun BookingsScreen(vm: BookingsViewModel, serviceLine: String, onAssign: (BookingEntity) -> Unit, onSeated: () -> Unit) {
    val ui by vm.ui.collectAsState()
    var adding by remember { mutableStateOf(false) }
    val live = ui.rows.map { it.booking }.filter { it.status != "noshow" }
    Column(Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ScreenHead(serviceLine, L.t("Bookings", "Réservations"))
            Gap()
            VBtn("New booking", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, pad = 22.dp, icon = VI.Plus) { adding = true }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf(
                "Bookings" to live.size, "Covers" to live.sumOf { it.size },
                "Seated" to live.filter { it.status == "seated" }.sumOf { it.size }, "Still to come" to live.filter { it.status != "seated" }.sumOf { it.size },
            ).forEach { (label, value) ->
                Column(Modifier.weight(1f).panel(18.dp).padding(horizontal = 18.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    T(label, 13.sp, 500, V.Text2)
                    T(value.toString(), 28.sp, 700, spacing = (-0.8).sp)
                }
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().panel(20.dp)) {
            if (ui.rows.isEmpty()) item { T("No bookings for today. New booking adds one; the back office has the days ahead.", 15.sp, 500, V.Text2, Modifier.padding(48.dp), lines = 3) }
            items(ui.rows, key = { it.booking.id }) { r ->
                val b = r.booking
                val up = b.status == "confirmed" || b.status == "pending"
                val st = when (b.status) {
                    "seated" -> Triple("Seated", V.GreenWash, V.GreenText); "pending" -> Triple("To confirm", V.AmberWash, V.AmberText)
                    "noshow" -> Triple("No-show", V.RedWash, V.RedText); else -> Triple("Confirmed", V.BlueWash, V.BlueSoft)
                }
                Column(Modifier.alpha(if (b.status == "noshow") 0.45f else 1f)) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        T(HM.format(Date(b.booked_for)), 17.sp, 700, modifier = Modifier.width(COLS[0]))
                        Column(Modifier.weight(1.4f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T(b.name, 16.sp, 700)
                            T(b.phone ?: "", 12.sp, 500, V.Text2)
                        }
                        Row(Modifier.width(COLS[2]), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            VIcon(VI.Person, 16.dp, V.Text2)
                            T(b.size.toString(), 16.sp, 700)
                        }
                        Column(Modifier.weight(0.9f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T(r.table?.name ?: "—", 15.sp, 700)
                            T(r.table?.area ?: b.area ?: "", 13.sp, 500, V.Text2)
                        }
                        T(b.tags ?: "", 13.sp, 700, V.VioletText, Modifier.weight(1.1f), lines = 2, height = 18.sp)
                        Box(Modifier.width(COLS[5])) { Chip(st.first, st.second, st.third, 28.dp, 8.dp, 13.sp) }
                        Row(Modifier.width(COLS[6]), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                            if (b.status == "pending") VBtn("Confirm", height = 46.dp, size = 14.sp, pad = 14.dp) { vm.confirm(b) }
                            if (up) VBtn("No-show", height = 46.dp, size = 14.sp, pad = 14.dp, fg = V.Dim) { vm.noShow(b) }
                            if (up && r.table == null) VBtn("Assign table", bg = V.On, fg = V.OnText, height = 46.dp, size = 14.sp, pad = 16.dp) { onAssign(b) }
                            if (up && r.table != null && r.tableFree) VBtn("Seat", bg = V.Blue, fg = Color.White, height = 46.dp, size = 14.sp, pad = 18.dp) { vm.seat(r, onSeated) }
                            if (up && r.table != null && !r.tableFree) VBtn("Table busy", height = 46.dp, size = 14.sp, pad = 14.dp, fg = V.Text3, enabled = false) {}
                        }
                    }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
                }
            }
        }
    }
    if (adding) NewBooking(ui.areas, vm) { adding = false }
}

@Composable
private fun NewBooking(areas: List<String>, vm: BookingsViewModel, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var tags by remember { mutableStateOf("") }
    var size by remember { mutableIntStateOf(2) }
    var day by remember { mutableIntStateOf(0) }
    val nowT = remember { LocalTime.now() }
    var hour by remember { mutableIntStateOf((nowT.hour + 1).coerceAtMost(23)) }
    var minute by remember { mutableIntStateOf(0) }
    var area by remember { mutableStateOf(areas.firstOrNull()) }
    val date = LocalDate.now().plusDays(day.toLong())
    Sheet(onDismiss = onDismiss, width = 620.dp) {
        SheetHead("New booking", "The table is picked afterwards, with Assign table.", onDismiss)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Field(name, { name = it.take(60) }, "Name", Modifier.weight(1.2f), height = 54.dp)
            Field(phone, { phone = it.take(24) }, "+230 5…", Modifier.weight(1f), height = 54.dp, phone = true)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Guests")
                Stepper(size.toString(), key = 48.dp, width = 48.dp, big = 20.sp, onDown = { size = (size - 1).coerceAtLeast(1) }, onUp = { size = (size + 1).coerceAtMost(99) })
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Day")
                Stepper(
                    when (day) { 0 -> "Today"; 1 -> "Tomorrow"; else -> date.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.UK)) },
                    key = 48.dp, width = 120.dp, big = 16.sp, onDown = { day = (day - 1).coerceAtLeast(0) }, onUp = { day = (day + 1).coerceAtMost(60) },
                )
            }
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Time")
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Stepper(hour.toString().padStart(2, '0'), key = 48.dp, width = 40.dp, big = 20.sp, onDown = { hour = (hour + 23) % 24 }, onUp = { hour = (hour + 1) % 24 })
                    T(":", 20.sp, 800, V.Text2)
                    Stepper(minute.toString().padStart(2, '0'), key = 48.dp, width = 40.dp, big = 20.sp, onDown = { minute = (minute + 45) % 60 }, onUp = { minute = (minute + 15) % 60 })
                }
            }
            if (areas.size > 1) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Caps("Where")
                    Seg(areas.take(3).map { a -> SegOption(a, a == area) { area = a } }, well = V.Well, height = 48.dp, pad = 12.dp)
                }
            }
        }
        Field(tags, { tags = it.take(120) }, "Notes · e.g. Birthday cake 21:00, nut allergy, high chair", Modifier.fillMaxWidth(), height = 54.dp)
        VBtn("Book the table", Modifier.fillMaxWidth(), V.Blue, Color.White, 60.dp, size = 16.sp, weight = 800) { vm.add(day, hour, minute, name, size, phone, area, tags, onDismiss) }
    }
}
