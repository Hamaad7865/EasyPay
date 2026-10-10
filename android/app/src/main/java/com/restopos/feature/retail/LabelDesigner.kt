package com.restopos.feature.retail

import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.print.LabelEdit
import com.restopos.core.print.LabelElement
import com.restopos.core.print.LabelLayout
import com.restopos.core.print.LabelTemplate
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toggle
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.press
import com.restopos.core.ui.quietTap
import kotlin.math.abs

// The label designer, a shop's: the label between millimetre rulers on the
// left, drawn by the layout and the painter that print it, so what is seen is
// what comes out; under it the keys that nudge, size, turn and remove what is
// selected; on the right the label's own name, size and gap, what is selected,
// everything on the label as a list, and what can be added. Every change is
// LabelEdit's: this screen only says what was tapped or dragged.
@Composable
fun LabelDesigner(vm: LabelsViewModel, d: LabelDraft) {
    var confirm by remember { mutableStateOf<String?>(null) } // close | delete
    var asking by remember { mutableStateOf<NumAsk?>(null) }
    var wording by remember { mutableStateOf(false) } // the selected text's own words are being typed
    val busy by vm.busy.collectAsState()
    val t = d.template
    val sel = d.selected?.let { t.elements.getOrNull(it) }
    val drawn = remember(t) { vm.drawn(t) }
    val leave = { if (d.changed) confirm = "close" else vm.closeDraft() }
    BackHandler(onBack = leave)

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            IconKey(VI.Back, size = 48.dp, onClick = leave)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                T(if (d.saved) "Change a label" else "New label", 20.sp, 800, spacing = (-0.3).sp)
                T("${t.size} mm, drawn as it will print", 13.sp, 500, V.Text2)
            }
            if (d.saved) VBtn("Delete", bg = V.RedWash, fg = V.RedText, height = 48.dp) { confirm = "delete" }
            VBtn(if (busy) "Sending…" else "Print a test", height = 48.dp, enabled = !busy, icon = VI.Print) { vm.testDraft() }
            VBtn("Save", bg = V.Green, fg = V.GreenInk, height = 48.dp, size = 16.sp, weight = 800, pad = 30.dp) { vm.saveDraft() }
        }
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(V.Panel)) { Sheet(d, drawn.picture, vm) }
                Keys(sel, drawn.noBars, vm)
            }
            Panel(t, d.selected, sel, vm, Modifier.width(390.dp), onAsk = { asking = it }, onWords = { wording = true })
        }
    }

    asking?.let { NumSheet(it) { asking = null } }
    if (wording && sel is LabelElement.Text) WordsSheet(sel.text, onDismiss = { wording = false }) { said ->
        wording = false
        vm.edit { tt, i -> LabelEdit.with(tt, i, sel.copy(text = said)) }
    }
    when (confirm) {
        "close" -> Sheet(onDismiss = { confirm = null }, width = 520.dp) {
            SheetHead("Leave without saving?", "What was changed on this label is lost.") { confirm = null }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep designing", Modifier.weight(1f), height = 60.dp) { confirm = null }
                VBtn("Leave", Modifier.weight(1f), V.Red, Color.White, 60.dp, weight = 800) { confirm = null; vm.closeDraft() }
            }
        }
        "delete" -> Sheet(onDismiss = { confirm = null }, width = 520.dp) {
            SheetHead("Delete ${d.first.name}?", "It is removed from this tablet for good.") { confirm = null }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep it", Modifier.weight(1f), height = 60.dp) { confirm = null }
                VBtn("Delete the label", Modifier.weight(1f), V.Red, Color.White, 60.dp, weight = 800) { confirm = null; vm.deleteDraft() }
            }
        }
    }
}

// ---------------------------------------------------------------- the label

private val RULER = 22.dp

// The label, as large as its room allows, between its rulers. The picture is
// the printed one; over it only what is selected is marked. A tap selects the
// smallest thing under the finger, a drag moves it, and a drag that starts on
// the corner of what is selected sizes it.
@Composable
private fun Sheet(d: LabelDraft, picture: Bitmap, vm: LabelsViewModel) {
    val t = d.template
    BoxWithConstraints(Modifier.fillMaxSize().padding(14.dp)) {
        // dp to a millimetre: all the room there is, but a small label is not blown up until it looks coarse
        val k = minOf((maxWidth - RULER).value / t.widthMm, (maxHeight - RULER).value / t.heightMm, 16f)
        val perMm = with(LocalDensity.current) { k.dp.toPx() }
        val now by rememberUpdatedState(d)
        val scale by rememberUpdatedState(perMm)
        Rulers(t, k)
        Box(
            Modifier.offset(RULER, RULER).size((t.widthMm * k).dp, (t.heightMm * k).dp).background(Color.White).border(1.dp, V.Stroke)
                .pointerInput(Unit) { detectTapGestures { p -> vm.select(LabelEdit.hit(now.template, p.x / scale, p.y / scale)) } }
                .pointerInput(Unit) {
                    var at = -1
                    var sizing = false
                    var x0 = 0f
                    var y0 = 0f
                    var w0 = 0f
                    var h0 = 0f
                    var dx = 0f
                    var dy = 0f
                    detectDragGestures(
                        onDragStart = { p ->
                            val label = now.template
                            val mx = p.x / scale
                            val my = p.y / scale
                            // the corner of what is selected, a finger wide, comes before whatever lies under it
                            val held = now.selected?.let { label.elements.getOrNull(it) }?.let { LabelEdit.box(it) }
                            val reach = 24.dp.toPx() / scale
                            sizing = held != null && abs(mx - (held.x + held.w)) <= reach && abs(my - (held.y + held.h)) <= reach
                            at = if (sizing) now.selected ?: -1 else LabelEdit.hit(label, mx, my) ?: -1
                            label.elements.getOrNull(at)?.let { e ->
                                val b = LabelEdit.box(e)
                                x0 = b.x; y0 = b.y; w0 = b.w; h0 = b.h; dx = 0f; dy = 0f
                                vm.select(at)
                            }
                        },
                        onDrag = { change, amount ->
                            change.consume()
                            if (at >= 0) {
                                dx += amount.x / scale
                                dy += amount.y / scale
                                val i = at
                                if (sizing) vm.edit { tt, _ -> LabelEdit.sizeTo(tt, i, w0 + dx, h0 + dy) }
                                else vm.edit { tt, _ -> LabelEdit.moveTo(tt, i, x0 + dx, y0 + dy) }
                            }
                        },
                    )
                },
        ) {
            Image(picture.asImageBitmap(), contentDescription = "The label as it will print", Modifier.fillMaxSize(), contentScale = ContentScale.FillBounds, filterQuality = FilterQuality.Medium)
            d.selected?.let { t.elements.getOrNull(it) }?.let { e ->
                val b = LabelEdit.box(e)
                Box(Modifier.offset((b.x * k).dp, (b.y * k).dp).size((b.w * k).dp.coerceAtLeast(2.dp), (b.h * k).dp.coerceAtLeast(2.dp)).border(1.5.dp, V.Blue))
                // the handle that sizes it
                Box(
                    Modifier.offset(((b.x + b.w) * k).dp - 8.dp, ((b.y + b.h) * k).dp - 8.dp).size(16.dp).clip(CircleShape).background(V.Blue).border(2.dp, Color.White, CircleShape),
                )
            }
        }
    }
}

// The rulers along the top and the left: a mark a millimetre where there is
// room for them, a longer one every five, a number every ten.
@Composable
private fun Rulers(t: LabelTemplate, k: Float) {
    val ink = V.Text3
    val numbers = remember(ink) { android.graphics.Paint().apply { isAntiAlias = true; color = ink.toArgb() } }
    Canvas(Modifier.fillMaxSize()) {
        val start = RULER.toPx()
        val mm = k.dp.toPx()
        numbers.textSize = 10.sp.toPx()
        val every = if (k >= 5f) 1 else 5
        fun mark(at: Int): Float = when { at % 10 == 0 -> 11.dp.toPx(); at % 5 == 0 -> 7.dp.toPx(); else -> 4.dp.toPx() }
        var at = 0
        while (at <= t.widthMm.toInt()) {
            val x = start + at * mm
            drawLine(ink, Offset(x, start - mark(at)), Offset(x, start), 1.dp.toPx())
            if (at % 10 == 0 && at > 0) drawContext.canvas.nativeCanvas.drawText("$at", x + 2.dp.toPx(), start - 12.dp.toPx(), numbers)
            at += every
        }
        at = 0
        while (at <= t.heightMm.toInt()) {
            val y = start + at * mm
            drawLine(ink, Offset(start - mark(at), y), Offset(start, y), 1.dp.toPx())
            if (at % 10 == 0 && at > 0) drawContext.canvas.nativeCanvas.drawText("$at", 0f, y + 11.dp.toPx(), numbers)
            at += every
        }
    }
}

// ---------------------------------------------------------------- the keys under the label

@Composable
private fun Keys(sel: LabelElement?, noBars: String?, vm: LabelsViewModel) {
    val on = sel != null
    // letters to size, or a line's or a box's thickness
    val sized = sel is LabelElement.Text || sel is LabelElement.Line || sel is LabelElement.Box
    Row(Modifier.fillMaxWidth().height(52.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Key("←", on) { vm.edit { t, i -> LabelEdit.move(t, i, -LabelEdit.STEP, 0f) } }
        Key("→", on) { vm.edit { t, i -> LabelEdit.move(t, i, LabelEdit.STEP, 0f) } }
        Key("↑", on) { vm.edit { t, i -> LabelEdit.move(t, i, 0f, -LabelEdit.STEP) } }
        Key("↓", on) { vm.edit { t, i -> LabelEdit.move(t, i, 0f, LabelEdit.STEP) } }
        Spacer(Modifier.width(6.dp))
        Key("A−", on && sized) { vm.edit { t, i -> LabelEdit.bigger(t, i, -1) } }
        Key("A+", on && sized) { vm.edit { t, i -> LabelEdit.bigger(t, i, 1) } }
        Spacer(Modifier.width(6.dp))
        Key("Turn 90°", on && sel !is LabelElement.Logo, 104.dp) { vm.edit { t, i -> LabelEdit.turn(t, i) } }
        Key("Remove", on, 92.dp, V.RedText) { vm.edit(select = -1) { t, i -> LabelEdit.remove(t, i) } }
        // what the label lacks, said while it is designed; else how the label is worked
        T(
            noBars ?: if (on) "Drag it to move it, or its blue corner to size it. The arrows move it half a millimetre." else "Tap a thing on the label to select it, or pick it in the list.",
            12.sp, 600, if (noBars != null) V.AmberText else V.Text3, Modifier.weight(1f).padding(start = 6.dp), lines = 3, height = 15.sp,
        )
    }
}

@Composable
private fun Key(label: String, on: Boolean, width: Dp = 52.dp, ink: Color = V.Text, onClick: () -> Unit) {
    Box(
        Modifier.width(width).height(52.dp).then(if (on) Modifier.press(0.94f, onClick) else Modifier).clip(RoundedCornerShape(14.dp)).background(V.Panel),
        contentAlignment = Alignment.Center,
    ) { T(label, if (label.length <= 2) 19.sp else 14.sp, 700, if (on) ink else V.Off) }
}

// ---------------------------------------------------------------- the panel

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Panel(t: LabelTemplate, at: Int?, sel: LabelElement?, vm: LabelsViewModel, modifier: Modifier, onAsk: (NumAsk) -> Unit, onWords: () -> Unit) {
    Column(
        modifier.fillMaxHeight().clip(RoundedCornerShape(20.dp)).background(V.Panel).verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Caps("The label")
        Field(t.name, { name -> vm.edit { tt, _ -> tt.copy(name = name.take(40)) } }, "Its name", Modifier.fillMaxWidth(), height = 50.dp)
        Stepper("Width", t.widthMm, 1f, "From ${LabelEdit.WIDE.start.toInt()} to ${LabelEdit.WIDE.endInclusive.toInt()} mm", onAsk) { v -> vm.edit { tt, _ -> LabelEdit.resize(tt, v, tt.heightMm, tt.gapMm) } }
        Stepper("Height", t.heightMm, 1f, "From ${LabelEdit.HIGH.start.toInt()} to ${LabelEdit.HIGH.endInclusive.toInt()} mm", onAsk) { v -> vm.edit { tt, _ -> LabelEdit.resize(tt, tt.widthMm, v, tt.gapMm) } }
        Stepper("Gap to the next label", t.gapMm, LabelEdit.STEP, "Usually 2 mm; 0 for a roll with no gaps", onAsk) { v -> vm.edit { tt, _ -> LabelEdit.resize(tt, tt.widthMm, tt.heightMm, v) } }

        if (sel != null) {
            Caps("Selected: " + LabelEdit.says(sel), modifier = Modifier.padding(top = 8.dp))
            Selected(sel, vm, onAsk, onWords)
        }

        Caps("On the label", modifier = Modifier.padding(top = 8.dp))
        if (t.elements.isEmpty()) T("Nothing yet. Add what the label should carry.", 13.sp, 500, V.Text2)
        else Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Well)) {
            t.elements.forEachIndexed { i, e ->
                if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                val on = i == at
                Row(Modifier.fillMaxWidth().background(if (on) V.RowOn else V.Well).quietTap { vm.select(if (on) null else i) }.padding(horizontal = 14.dp).height(44.dp), verticalAlignment = Alignment.CenterVertically) {
                    T(LabelEdit.says(e), 14.sp, if (on) 800 else 600, V.Text, Modifier.weight(1f))
                    val turn = when (e) { is LabelElement.Text -> LabelLayout.quarter(e.turn); is LabelElement.Bars -> LabelLayout.quarter(e.turn); else -> 0 }
                    if (turn != 0) T("turned $turn°", 12.sp, 500, V.Text3)
                }
            }
        }

        Caps("Add", modifier = Modifier.padding(top = 8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            LabelEdit.KINDS.forEach { (kind, name) ->
                val can = kind != "logo" || vm.hasLogo
                Box(
                    Modifier.height(40.dp).then(if (can) Modifier.press { vm.edit(select = t.elements.size) { tt, _ -> LabelEdit.add(tt, kind) } } else Modifier)
                        .clip(RoundedCornerShape(20.dp)).background(V.Key).padding(horizontal = 14.dp),
                    contentAlignment = Alignment.Center,
                ) { T(name, 13.sp, 700, if (can) V.Text else V.Off) }
            }
        }
        if (!vm.hasLogo) T("The logo is the one set in the back office, under POS settings. This shop has none yet.", 12.sp, 500, V.Text3, lines = 2, height = 16.sp)
    }
}

// What can be changed of the thing that is selected, besides where it is.
@Composable
private fun Selected(e: LabelElement, vm: LabelsViewModel, onAsk: (NumAsk) -> Unit, onWords: () -> Unit) {
    val b = LabelEdit.box(e)
    fun change(next: LabelElement) = vm.edit { t, i -> LabelEdit.with(t, i, next) }
    when (e) {
        is LabelElement.Text -> {
            // words of the shop's own are typed; a product's words come with each product
            if (e.field.isEmpty()) Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.Well).quietTap(onWords).padding(horizontal = 14.dp).height(46.dp), verticalAlignment = Alignment.CenterVertically) {
                T(e.text.ifBlank { "Its words" }, 14.sp, 700, if (e.text.isBlank()) V.Text3 else V.Text, Modifier.weight(1f))
                T("Change", 13.sp, 700, V.BlueText)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Seg(
                    listOf(
                        SegOption("Left", e.align == "left") { change(e.copy(align = "left")) },
                        SegOption("Centre", e.align != "left" && e.align != "right") { change(e.copy(align = "center")) },
                        SegOption("Right", e.align == "right") { change(e.copy(align = "right")) },
                    ),
                    Modifier.weight(1f), V.Well, 42.dp, 12.dp, fill = true, size = 13.sp, pad = 8.dp,
                )
                Row(Modifier.quietTap { change(e.copy(bold = !e.bold)) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    T("Bold", 14.sp, 700)
                    Toggle(e.bold)
                }
            }
            // more lines need more room: the box grows with them (LabelEdit.bigger by nothing)
            Stepper("Lines", e.lines.toFloat(), 1f, null, onAsk, whole = true) { v ->
                vm.edit { t, i -> LabelEdit.bigger(LabelEdit.with(t, i, e.copy(lines = v.toInt().coerceIn(1, 4))), i, 0) }
            }
            Stepper("Letters", e.size, 0.3f, null, onAsk, unit = "mm high") { v -> change(e.copy(size = v.coerceIn(LabelEdit.LETTERS))) }
        }
        is LabelElement.Bars -> Row(Modifier.fillMaxWidth().quietTap { change(e.copy(digits = if (e.digits > 0f) 0f else 2.4f)) }, verticalAlignment = Alignment.CenterVertically) {
            T("The code in digits under the bars", 14.sp, 600, V.Text, Modifier.weight(1f))
            Toggle(e.digits > 0f)
        }
        else -> Unit
    }
    if (e is LabelElement.Line) {
        val flat = b.w >= b.h
        Stepper("Length", if (flat) b.w else b.h, LabelEdit.STEP, null, onAsk) { v -> vm.edit { t, i -> LabelEdit.sizeTo(t, i, v, v) } }
        Stepper("Thickness", if (flat) b.h else b.w, 0.1f, null, onAsk) { v -> change(if (flat) e.copy(h = v.coerceIn(LabelEdit.THICK)) else e.copy(w = v.coerceIn(LabelEdit.THICK))) }
    } else {
        Stepper("Width", b.w, LabelEdit.STEP, null, onAsk) { v -> vm.edit { t, i -> LabelEdit.sizeTo(t, i, v, b.h) } }
        Stepper("Height", b.h, LabelEdit.STEP, null, onAsk) { v -> vm.edit { t, i -> LabelEdit.sizeTo(t, i, b.w, v) } }
        if (e is LabelElement.Box) Stepper("Thickness", e.thick, 0.1f, null, onAsk) { v -> change(e.copy(thick = v.coerceIn(LabelEdit.THICK))) }
    }
}

// A figure with a key each side of it; tapping the figure types it.
@Composable
private fun Stepper(label: String, value: Float, step: Float, hint: String?, onAsk: (NumAsk) -> Unit, unit: String = "mm", whole: Boolean = false, set: (Float) -> Unit) {
    val shown = if (whole) "${value.toInt()}" else LabelTemplate.mm(Math.round(value * 10f) / 10f)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        T(label, 14.sp, 600, V.Text, Modifier.weight(1f))
        StepKey("−") { set(value - step) }
        Box(
            Modifier.width(92.dp).height(44.dp).clip(RoundedCornerShape(12.dp)).background(V.Well).quietTap {
                onAsk(NumAsk(label, hint, if (whole) "" else unit, if (whole) 0 else 1, "") { typed -> typed.toFloatOrNull()?.let(set) })
            },
            contentAlignment = Alignment.Center,
        ) { T(if (whole) shown else "$shown ${unit.substringBefore(' ')}", 15.sp, 800) }
        StepKey("+") { set(value + step) }
    }
}

// The shop's own words on a label, typed in a sheet at the top of the screen,
// where the keyboard that opens does not cover it.
@Composable
private fun WordsSheet(was: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var said by remember(was) { mutableStateOf(was) }
    Sheet(onDismiss = onDismiss, width = 520.dp, top = true) {
        SheetHead("Its words", "They print on every label as written here.", onDismiss)
        Field(said, { said = it.take(60) }, "The shop's name, a slogan, Made in Mauritius…", Modifier.fillMaxWidth(), height = 56.dp, onDone = { onSave(said) })
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Cancel", Modifier.weight(1f), height = 56.dp) { onDismiss() }
            VBtn("Done", Modifier.weight(2f), V.Green, V.GreenInk, 56.dp, 16.dp, 16.sp, 800) { onSave(said) }
        }
    }
}
