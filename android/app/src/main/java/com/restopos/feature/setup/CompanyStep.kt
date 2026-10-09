package com.restopos.feature.setup

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.data.CompanyForm
import com.restopos.core.data.SetupFacts
import com.restopos.core.data.SetupStep
import com.restopos.core.data.SetupSteps
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.feature.auth.Problem
import com.restopos.feature.auth.SetupField

// Who the business is on paper: what prints at the top of every receipt. The
// boxes on the left, and beside them the top of a receipt as it will print,
// redrawn as they are typed in.
@Composable
internal fun CompanyStep(vm: SetupViewModel, facts: SetupFacts, next: () -> Unit) {
    val company by vm.company.collectAsState()
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    val had = company
    if (had == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp), color = V.Cyan, strokeWidth = 2.5.dp) }
        return
    }
    // what the business has, until it is typed over; after a save, what was saved
    var name by rememberSaveable(had.name) { mutableStateOf(had.name) }
    var address by rememberSaveable(had.address) { mutableStateOf(had.address) }
    var phone by rememberSaveable(had.phone) { mutableStateOf(had.phone) }
    var brn by rememberSaveable(had.brn) { mutableStateOf(had.brn) }
    var vat by rememberSaveable(had.vat) { mutableStateOf(had.vat) }
    val read = CompanyForm.read(name, address, phone, brn, vat)
    val typed = read.getOrNull()
    val changed = typed == null || !CompanyForm.same(typed, CompanyForm.read(had.name, had.address, had.phone, had.brn, had.vat).getOrNull() ?: had)
    val done = SetupSteps.done(SetupStep.Company, facts)

    StepBody(
        title = "The top of the receipt",
        sub = "Who the business is on paper. It prints on every receipt, bill and closing report.",
        foot = {
            when {
                typed == null -> StepFoot("Enter the business's name", ready = false, busy = false, quiet = if (done) null else SKIP, onQuiet = next, onMain = {})
                changed -> StepFoot("Save and continue", ready = true, busy = busy, quiet = if (done) null else SKIP, onQuiet = next) { vm.saveCompany(typed, next) }
                else -> StepFoot("Continue", ready = true, busy = false, onMain = next)
            }
        },
    ) {
        problem?.let { Problem(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(26.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SetupField("Business name", name, { name = it; vm.clear() }, "Chez Nous", enabled = !busy, ime = ImeAction.Next)
                SetupField("Address", address, { address = it; vm.clear() }, "Royal Road\nCurepipe", enabled = !busy, lines = 3)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    SetupField("Phone", phone, { phone = it; vm.clear() }, "5 123 4567", Modifier.weight(1f), enabled = !busy, keyboard = KeyboardType.Phone, ime = ImeAction.Next)
                    SetupField("BRN", brn, { brn = it; vm.clear() }, "C12345678", Modifier.weight(1f), enabled = !busy, ime = ImeAction.Next)
                }
                SetupField("VAT number", vat, { vat = it; vm.clear() }, "VAT27000000", enabled = !busy, ime = ImeAction.Done)
                T("A box left empty prints nothing.", 13.sp, 500, V.Text3)
            }
            Column(Modifier.width(290.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                T("The top of every receipt", 13.sp, 600, V.Text2)
                ReceiptTop(CompanyForm.top(typed ?: CompanyForm.Company(name.trim(), address.trim(), phone.trim(), brn.trim(), vat.trim())))
            }
        }
    }
}

// A strip of receipt paper with the head of a receipt on it, torn off below.
// Paper is white and its ink dark whichever way the till's own colours are set.
@Composable
private fun ReceiptTop(lines: List<String>) {
    val paper = Color(0xFFFCFCFA)
    val ink = Color(0xFF1B1D22)
    Column(Modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp)).background(paper).padding(start = 18.dp, end = 18.dp, top = 22.dp, bottom = 14.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp), horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            lines.forEachIndexed { i, line ->
                if (line.isNotBlank()) Text(
                    line, color = ink, fontFamily = FontFamily.Monospace, textAlign = TextAlign.Center,
                    fontSize = if (i == 0) 17.sp else 12.5.sp, fontWeight = if (i == 0) FontWeight.Bold else FontWeight.Normal,
                    lineHeight = if (i == 0) 22.sp else 17.sp, modifier = Modifier.fillMaxWidth(),
                )
            }
            if (lines.all { it.isBlank() }) Text("Your business's name", color = Color(0xFFA3A9B5), fontFamily = FontFamily.Monospace, fontSize = 15.sp)
            // where the receipt's own lines begin
            Text("- - - - - - - - - - - - - - - -", color = Color(0xFFB9BEC8), fontFamily = FontFamily.Monospace, fontSize = 12.sp, maxLines = 1, modifier = Modifier.padding(top = 8.dp))
        }
        // the torn edge
        Canvas(Modifier.fillMaxWidth().height(9.dp)) {
            val tooth = 9.dp.toPx()
            val path = Path().apply {
                moveTo(0f, 0f)
                var x = 0f
                while (x < size.width) {
                    lineTo(x + tooth / 2, size.height)
                    lineTo(minOf(x + tooth, size.width), 0f)
                    x += tooth
                }
                close()
            }
            drawPath(path, paper)
            drawLine(paper, Offset(0f, 0f), Offset(size.width, 0f), 1f)
        }
    }
}
