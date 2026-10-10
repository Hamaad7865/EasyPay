package com.restopos.feature.reports

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.data.Reports
import com.restopos.core.ui.Gap
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.Stepper
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.panel
import com.restopos.core.ui.press
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

private val DATE = DateTimeFormatter.ofPattern("EEE d MMM yyyy", Locale.US)
private val SINCE = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.US)

// Reports: the nine listed on the left as on the owner's picture, the open one
// on the right, of the days picked above it. Every figure is of this till and
// read from the tablet itself.
// onReceipt: a receipt tapped in Transaction Detail, opened where receipts are.
@Composable
fun ReportsScreen(vm: ReportsViewModel, onReceipt: (String) -> Unit) {
    val allowed by vm.allowed.collectAsState()
    // read again each time the screen is opened; a manager's word is for while it is open
    LaunchedEffect(Unit) { vm.refresh() }
    DisposableEffect(Unit) { onDispose { vm.leave() } }
    if (!allowed) {
        Column(Modifier.fillMaxSize().padding(40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically)) {
            T("Reports", 26.sp, 700, spacing = (-0.6).sp)
            T("Sales, receipts, VAT and the days closed on this till are for those allowed to see the day's figures. Someone who is can show them with their PIN.", 15.sp, 500, V.Text2, Modifier.widthIn(max = 520.dp), lines = 4, align = TextAlign.Center)
            VBtn("Show the reports", bg = V.Blue, fg = Color.White, height = 56.dp, pad = 24.dp) { vm.unlock() }
        }
        return
    }
    val report by vm.report.collectAsState()
    val pick by vm.pick.collectAsState()
    val data by vm.data.collectAsState()
    val since by vm.since.collectAsState()
    val busy by vm.busy.collectAsState()
    val day by vm.day.collectAsState()
    var dates by remember { mutableStateOf(false) }

    Row(Modifier.fillMaxSize().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        // the nine, as the picture lists them
        Column(Modifier.width(250.dp).fillMaxHeight().panel().verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
            Report.entries.forEach { r ->
                val on = r == report
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp).clip(RoundedCornerShape(12.dp)).background(if (on) V.On else Color.Transparent)
                        .press(0.98f) { vm.open(r) }.padding(horizontal = 14.dp).height(50.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    T(r.label, 15.sp, 700, if (on) V.OnText else V.Text, Modifier.weight(1f))
                    VIcon(VI.Chevron, 16.dp, if (on) V.OnSub else V.Text3)
                }
            }
        }
        Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(report.label, 24.sp, 700, spacing = (-0.5).sp)
                    val covers = "This till" + (since?.let { ", since " + SINCE.format(Instant.ofEpochMilli(it).atZone(vm.zone())) } ?: "")
                    T((data?.let { Reports.says(it.span) + " · " } ?: "") + covers, 13.sp, 500, V.Text2)
                }
                VBtn(if (busy) "Printing…" else "Print", height = 44.dp, pad = 18.dp, icon = VI.Print, enabled = !busy && data != null) { vm.print() }
            }
            Seg(
                Reports.Pick.entries.map { p ->
                    SegOption(p.label, p == pick) { if (p == Reports.Pick.Custom) dates = true else vm.pick(p) }
                },
                well = V.Panel, height = 40.dp, size = 14.sp, pad = 14.dp,
            )
            Box(Modifier.fillMaxWidth().weight(1f)) {
                val d = data
                if (d == null) T("Reading the receipts…", 15.sp, 500, V.Text2, Modifier.padding(24.dp))
                else ReportView(report, d, vm, onReceipt)
            }
        }
    }
    if (dates) DatesSheet(vm) { dates = false }
    day?.let { DaySheet(it, vm) }
}

// Two dates, each stepped a day at a time: reports are of whole days.
@Composable
private fun DatesSheet(vm: ReportsViewModel, onDone: () -> Unit) {
    val today = remember { LocalDate.now(vm.zone()) }
    var from by remember { mutableStateOf(vm.from.value) }
    var to by remember { mutableStateOf(vm.to.value) }
    Sheet(onDismiss = onDone, width = 520.dp, gap = 16.dp) {
        SheetHead("Which days?", "From one day to another, both included.", onDone)
        for ((label, value, set) in listOf(Triple("From", from, { d: LocalDate -> from = d }), Triple("To", to, { d: LocalDate -> to = d }))) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                T(label, 16.sp, 700, V.Text2, Modifier.width(70.dp))
                Gap()
                Stepper(DATE.format(value), width = 190.dp, key = 46.dp, big = 16.sp, onDown = { set(value.minusDays(1)) }, onUp = { if (value < today) set(value.plusDays(1)) })
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Last 7 days", Modifier.weight(1f), height = 48.dp) { from = today.minusDays(6); to = today }
            VBtn("Last 30 days", Modifier.weight(1f), height = 48.dp) { from = today.minusDays(29); to = today }
        }
        VBtn("Show these days", Modifier.fillMaxWidth(), V.Green, V.GreenInk, 56.dp, 16.dp, 16.sp, 800) { vm.dates(minOf(from, to), maxOf(from, to)); onDone() }
    }
}
