package com.restopos.core.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.TweenSpec
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

// The redesigned till's colours. Dark is the design; light keeps the same
// roles on a pale screen, for a till that stands in daylight.
object V {
    private fun of(dark: Long, bright: Long) = Color(if (Pos.light) bright else dark)
    val Bg: Color get() = of(0xFF131519, 0xFFEEF0F4)
    val Header: Color get() = of(0xFF0D0F13, 0xFFFFFFFF)
    val HeaderLine: Color get() = of(0xFF22262E, 0xFFD9DCE4)
    val Panel: Color get() = of(0xFF1B1E24, 0xFFFFFFFF)
    val PanelFoot: Color get() = of(0xFF171A1F, 0xFFF5F6F9)
    val Side: Color get() = of(0xFF16191E, 0xFFF5F6F9)
    val Well: Color get() = of(0xFF131519, 0xFFE9EBF0) // the dip a stepper or a segmented control sits in
    val Key: Color get() = of(0xFF252932, 0xFFE4E7ED)
    val Key2: Color get() = of(0xFF22262E, 0xFFEBEDF2)
    val Hover: Color get() = of(0xFF2E333D, 0xFFD9DCE4)
    val Stroke: Color get() = of(0xFF2B3039, 0xFFD9DCE4)
    val Stroke2: Color get() = of(0xFF3A404B, 0xFFC4C9D4)
    val RowLine: Color get() = of(0xFF252932, 0xFFE4E7ED)
    val Text: Color get() = of(0xFFF2F4F7, 0xFF1A1C21)
    val Text2: Color get() = of(0xFFA6AEBB, 0xFF4B5261)
    val Text3: Color get() = of(0xFF79818F, 0xFF7A8191)
    val Dim: Color get() = of(0xFFD5DAE2, 0xFF2E3440)
    val Soft: Color get() = of(0xFFE6E9EE, 0xFF242830)
    val Off: Color get() = of(0xFF5E6672, 0xFFA3A9B5)
    // the lit choice of a segmented control: the screen's opposite
    val On: Color get() = of(0xFFF2F4F7, 0xFF1A1C21)
    val OnText: Color get() = of(0xFF0D0F13, 0xFFFFFFFF)
    val OnSub: Color get() = of(0xFF5B6577, 0xFFB9C0CC)
    // The accent: the logo's green, a shade deeper so white lettering on a key reads.
    // The names still say Blue: they name the role (the key that is on, the
    // table that is seated), which was blue in the design this came from.
    val Blue = Color(0xFF3F8443)
    val BlueText: Color get() = of(0xFF74B884, 0xFF2F6B33)
    val BlueSoft: Color get() = of(0xFF9FD4A8, 0xFF2F6B33)
    val BlueWash: Color get() = of(0xFF173321, 0xFFDDEFDD)
    val RowOn: Color get() = of(0xFF222E26, 0xFFE3F1E3)
    val Cyan = Color(0xFF74B884) // the green of the logo's hand and note
    val Green = Color(0xFF2BD48A)
    val GreenInk = Color(0xFF052A1B)
    val GreenWash: Color get() = of(0xFF0F2A1F, 0xFFD9F5E7)
    val GreenText: Color get() = of(0xFF2BD48A, 0xFF0F8050)
    val GreenOff: Color get() = of(0xFF1F3A2E, 0xFFCFE6DA)
    val GreenOffText: Color get() = of(0xFF6E9C86, 0xFF7FA693)
    val Ok = Color(0xFF12B76A)
    val Amber = Color(0xFFF5A524)
    val AmberInk = Color(0xFF2B1A00)
    val AmberText: Color get() = of(0xFFFFC15A, 0xFF9A6200)
    val AmberWash: Color get() = of(0xFF3A2A0B, 0xFFFCEFD2)
    val Red = Color(0xFFD93A40)
    val RedText: Color get() = of(0xFFFF8A8E, 0xFFC0272D)
    val RedWash: Color get() = of(0xFF3A1C1E, 0xFFFBE0E1)
    val Violet = Color(0xFF8B6CFF)
    val VioletText: Color get() = of(0xFFCBBEFF, 0xFF5B3FD6)
    val VioletWash: Color get() = of(0xFF241F3D, 0xFFE9E4FD)
    val VioletDeep: Color get() = of(0xFF221E36, 0xFFEFEBFE)
    val VioletLine: Color get() = of(0xFF3D3466, 0xFFCFC5F8)
    val TealWash: Color get() = of(0xFF0F3440, 0xFFD8F1F8)
    val TealText: Color get() = of(0xFF9BE3F7, 0xFF0B6A82)
    val TableFree: Color get() = of(0xFF2A2F38, 0xFFFFFFFF)
    val TableFreeLine: Color get() = of(0xFF3D434F, 0xFFC4C9D4)
    val SeatOff: Color get() = of(0xFF22262E, 0xFFE4E7ED)
    val SeatOffLine: Color get() = of(0xFF4A515E, 0xFFB5BBC7)
    val Scrim = Color(0x99000000)
    val LogoBrush = Brush.linearGradient(listOf(Color(0xFF74B884), Color(0xFF3F8443)))
}

// The design's icons: 24-unit line drawings, kept as their path data.
object VI {
    const val Menu = "M4 7h16M4 12h16M4 17h16"
    const val Floor = "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"
    const val Bolt = "M13 3L5 14h6l-1 7 8-11h-6z"
    const val Bag = "M5 8h14l-1.2 12H6.2zM9 8V6.5a3 3 0 0 1 6 0V8"
    const val Screen = "M3 5h18v11H3zM8 20h8M12 16v4"
    const val Calendar = "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"
    const val Bars = "M5 20v-8M12 20V5M19 20v-5M3 20h18"
    const val List = "M9 6h11M9 12h11M9 18h11M4.5 6h.5M4.5 12h.5M4.5 18h.5"
    const val Cash = "M3 7h18v12H3zM16 14h2M3 11h18"
    const val Close = "M6 6l12 12M18 6L6 18"
    const val Back = "M15 6l-6 6 6 6"
    const val Check = "M5 12l5 5 9-10"
    const val Receipt = "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3"
    const val Print = "M7 8V4h10v4M6 17H4v-6h16v6h-2M7 14h10v6H7z"
    const val Split = "M12 3v18M6 8l-3 4 3 4M18 8l3 4-3 4"
    const val Search = "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0 -14M20 20l-3.5-3.5"
    const val Clock = "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0 -17M12 7.5V12l3 2"
    const val Person = "M12 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0 -7M5 20c1-3.5 3.8-5 7-5s6 1.5 7 5"
    const val Qr = "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2"
    const val More = "M5 12h.01M12 12h.01M19 12h.01"
    const val People = "M9 5a3 3 0 1 0 0 6a3 3 0 1 0 0 -6M3 19c.8-3 3-4.5 6-4.5s5.200 1.500 6 4.500M16 5.500a2.500 2.500 0 1 1 0 5M17.500 14.800c2 .500 3.200 1.900 3.700 4.200"
    const val Gear = "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0 -6M12 3v3M12 18v3M3 12h3M18 12h3M5.600 5.600l2.100 2.100M16.300 16.300l2.100 2.100M5.600 18.400l2.100-2.100M16.300 7.700l2.100-2.100"
    const val Orders = "M6 4h12v16H6zM9 8h6M9 12h6M9 16h4"
    const val Lock = "M6 11h12v9H6zM8.500 11V8a3.500 3.500 0 0 1 7 0v3"
    const val Plus = "M12 5v14M5 12h14"
    const val Tag = "M4 4h8l8 8-8 8-8-8zM8.500 8.500h.01"
    const val Swap = "M4 8h14l-3-3M20 16H6l3 3"
    const val Note = "M5 4h14v12l-4 4H5zM15 20v-4h4M8 9h8M8 13h5"
    const val Trash = "M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"
    const val Minus = "M5 12h14"
    const val Chevron = "M9 6l6 6-6 6"
    const val Bell = "M6 16v-5a6 6 0 0 1 12 0v5l1.500 2.500h-15zM10 20.500a2 2 0 0 0 4 0"
    const val Card = "M3 6h18v12H3zM3 10h18M7 15h4"
    const val Sun = "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0 -8M12 3v2M12 19v2M3 12h2M19 12h2M5.600 5.600l1.400 1.400M17 17l1.400 1.400M5.600 18.400l1.400-1.400M17 7l1.400-1.400"
    const val Help = "M12 3.500a8.500 8.500 0 1 0 0 17a8.500 8.500 0 1 0 0 -17M9.600 9.500a2.500 2.500 0 1 1 3.600 2.300c-.800.500-1.200 1-1.200 1.800M12 16.800h.010"
    const val Signal = "M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0 -2M8.500 8.500a5 5 0 0 0 0 7M15.500 8.500a5 5 0 0 1 0 7M5.800 5.800a9 9 0 0 0 0 12.400M18.200 5.800a9 9 0 0 1 0 12.400"
    const val Warn = "M12 4l9 16H3zM12 10v4M12 17h.010"

    private val cache = HashMap<String, ImageVector>()
    fun of(d: String, width: Float = 2f): ImageVector = cache.getOrPut("$d@$width") {
        ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
            .addPath(
                pathData = addPathNodes(d), fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = width,
                strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round, pathFillType = PathFillType.NonZero,
            ).build()
    }
}

@Composable
fun VIcon(d: String, size: Dp = 20.dp, tint: Color = V.Text, width: Float = 2f, modifier: Modifier = Modifier) {
    Icon(VI.of(d, width), contentDescription = null, modifier = modifier.size(size), tint = tint)
}

// Text in the design's weights. 800 is its headline weight, 700 its label.
@Composable
fun T(
    text: String, size: TextUnit = 15.sp, weight: Int = 700, color: Color = V.Text, modifier: Modifier = Modifier,
    lines: Int = 1, align: TextAlign? = null, spacing: TextUnit = TextUnit.Unspecified, height: TextUnit = TextUnit.Unspecified,
    strike: Boolean = false,
) {
    Text(
        text, modifier, color = color, fontSize = size, fontWeight = FontWeight(weight), maxLines = lines,
        overflow = TextOverflow.Ellipsis, textAlign = align, letterSpacing = spacing, lineHeight = height,
        textDecoration = if (strike) androidx.compose.ui.text.style.TextDecoration.LineThrough else null,
    )
}

// A small heading in capitals: "IN THE KITCHEN", "KITCHEN NOTE".
@Composable
fun Caps(text: String, color: Color = V.Text3, modifier: Modifier = Modifier, size: TextUnit = 12.sp) {
    T(text.uppercase(), size, 800, color, modifier, spacing = 1.2.sp)
}

fun Modifier.tap(onClick: () -> Unit): Modifier = clickable(onClick = onClick)

// tappable with no ripple: a scrim, a whole card
@Composable
fun Modifier.quietTap(onClick: () -> Unit): Modifier =
    clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)

@Composable
fun VBtn(
    label: String, modifier: Modifier = Modifier, bg: Color = V.Key, fg: Color = V.Text, height: Dp = 56.dp, radius: Dp = 12.dp,
    size: TextUnit = 15.sp, weight: Int = 700, enabled: Boolean = true, icon: String? = null, pad: Dp = 16.dp, onClick: () -> Unit,
) {
    Row(
        modifier.height(height).clip(RoundedCornerShape(radius)).background(bg).then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = pad),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
    ) {
        if (icon != null) { VIcon(icon, 17.dp, fg); Spacer(Modifier.width(7.dp)) }
        T(label, size, weight, fg, align = TextAlign.Center, lines = 2, height = (size.value * 1.2f).sp)
    }
}

// A square key with an icon: close, back, the menu.
@Composable
fun IconKey(d: String, size: Dp = 44.dp, bg: Color = V.Key, tint: Color = V.Dim, radius: Dp = 12.dp, icon: Dp = 18.dp, width: Float = 2f, onClick: () -> Unit) {
    Box(Modifier.size(size).clip(RoundedCornerShape(radius)).background(bg).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        VIcon(d, icon, tint, width)
    }
}

// How the till moves. What comes onto the screen arrives fast and settles;
// what leaves goes quicker than it came; what travels (the pill under a lit
// key) is on a spring, so a second tap part-way turns it without a jerk.
// None of it makes anyone wait: a tap counts the moment it lands.
object Motion {
    private val Arrive = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    private val Leave = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
    fun <T> enter(ms: Int = 300): TweenSpec<T> = tween(ms, easing = Arrive)
    fun <T> exit(ms: Int = 200): TweenSpec<T> = tween(ms, easing = Leave)
    // the two edges of a pill on its way: the one in front goes ahead, the one behind catches up
    val Lead = spring(dampingRatio = 0.85f, stiffness = 620f, visibilityThreshold = 0.5f)
    val Trail = spring(dampingRatio = 0.85f, stiffness = 400f, visibilityThreshold = 0.5f)
    // something let go of mid-drag carries on at the finger's speed and comes to rest
    val Settle = spring(dampingRatio = 1f, stiffness = 500f, visibilityThreshold = 0.001f)
}

// How far a key has given under the finger: 1 at rest, a little less while
// it is held. A quick tap is still seen going down before it comes back.
@Composable
fun rememberPress(source: InteractionSource, to: Float = 0.96f): Animatable<Float, AnimationVector1D> {
    val s = remember { Animatable(1f) }
    LaunchedEffect(source) {
        source.interactions.collect { i ->
            when (i) {
                is PressInteraction.Press -> launch { s.animateTo(to, tween(90)) }
                is PressInteraction.Release -> launch {
                    if (s.value > (1f + to) / 2f) s.animateTo(to, tween(70))
                    s.animateTo(1f, spring(dampingRatio = 0.6f, stiffness = 700f))
                }
                is PressInteraction.Cancel -> launch { s.animateTo(1f, spring(stiffness = 700f)) }
            }
        }
    }
    return s
}

// A key that gives under the finger, in place of the ripple.
@Composable
fun Modifier.press(to: Float = 0.96f, onClick: () -> Unit): Modifier {
    val source = remember { MutableInteractionSource() }
    val s = rememberPress(source, to)
    return graphicsLayer { scaleX = s.value; scaleY = s.value }.clickable(interactionSource = source, indication = null, onClick = onClick)
}

// A row of keys with one pill under the lit one (lit is its place in the row,
// or -1 for none). Tap another and the pill slides to it, its front edge a
// little ahead, so it stretches on the way and gathers itself as it lands.
// Each key is drawn twice, as it reads off the pill and as it reads on it, and
// the second is cut to the pill: a label is in the pill's ink exactly where
// the pill is under it, however far across it has got.
@Composable
fun PillRow(
    count: Int, lit: Int, onTap: (Int) -> Unit, modifier: Modifier = Modifier, gap: Dp = 4.dp, radius: Dp = 12.dp, fill: Boolean = false,
    scroll: ScrollState? = null, cell: @Composable (index: Int, onPill: Boolean, modifier: Modifier) -> Unit,
) {
    val spots = remember(count) { mutableStateMapOf<Int, Pair<Float, Float>>() } // each key's left and right edge
    val left = remember { Animatable(0f) }
    val right = remember { Animatable(0f) }
    val shown = remember { Animatable(0f) }
    val at = remember { intArrayOf(-1, 0) } // the key the pill is on or on its way to, and whether it has ever been shown
    val sources = remember(count) { List(count) { MutableInteractionSource() } }
    val presses = sources.map { rememberPress(it) }
    val spot = spots[lit]
    LaunchedEffect(lit, spot) {
        if (spot == null) { at[0] = -1; shown.animateTo(0f, tween(120)); return@LaunchedEffect }
        val (l, r) = spot
        if (scroll != null) launch {
            // a lit key that is off the edge of a row that scrolls is brought back on
            if (l < scroll.value) scroll.animateScrollTo(l.toInt()) else if (r > scroll.value + scroll.viewportSize) scroll.animateScrollTo((r - scroll.viewportSize).toInt())
        }
        if (at[0] == -1 || at[0] == lit) {
            // Nowhere to travel from (the first time, or back from a screen with
            // no key here), or the row was laid out afresh under it (a count
            // appeared, the language changed): the pill is simply there.
            left.snapTo(l); right.snapTo(r)
            at[0] = lit
            if (at[1] == 0) { at[1] = 1; shown.snapTo(1f) } else shown.animateTo(1f, tween(160))
        } else {
            at[0] = lit
            val forward = l > left.value
            launch { shown.animateTo(1f, tween(160)) }
            launch { left.animateTo(l, if (forward) Motion.Trail else Motion.Lead) }
            launch { right.animateTo(r, if (forward) Motion.Lead else Motion.Trail) }
        }
    }
    val ink = V.On
    val cut = remember { Path() }
    Box(if (scroll != null) modifier.horizontalScroll(scroll) else modifier) {
        val row = if (fill) Modifier.fillMaxWidth() else Modifier
        Row(row, horizontalArrangement = Arrangement.spacedBy(gap)) {
            repeat(count) { i ->
                cell(
                    i, false,
                    (if (fill) Modifier.weight(1f) else Modifier)
                        .onPlaced { c -> val x = c.positionInParent().x; val v = x to x + c.size.width; if (spots[i] != v) spots[i] = v }
                        .graphicsLayer { val s = presses[i].value; scaleX = s; scaleY = s }
                        .clickable(interactionSource = sources[i], indication = null) { onTap(i) },
                )
            }
        }
        Row(
            row.clearAndSetSemantics {}.graphicsLayer { alpha = shown.value }.drawWithContent {
                if (right.value > left.value) {
                    val r = CornerRadius(radius.toPx())
                    drawRoundRect(ink, Offset(left.value, 0f), Size(right.value - left.value, size.height), r)
                    cut.rewind()
                    cut.addRoundRect(RoundRect(left.value, 0f, right.value, size.height, r))
                    clipPath(cut) { this@drawWithContent.drawContent() }
                }
            },
            horizontalArrangement = Arrangement.spacedBy(gap),
        ) {
            repeat(count) { i -> cell(i, true, (if (fill) Modifier.weight(1f) else Modifier).graphicsLayer { val s = presses[i].value; scaleX = s; scaleY = s }) }
        }
    }
}

class SegOption(val label: String, val on: Boolean, val sub: String? = null, val onClick: () -> Unit)

// A row of choices in a dip, the chosen one lit: the pill slides to it.
@Composable
fun Seg(options: List<SegOption>, modifier: Modifier = Modifier, well: Color = V.Panel, height: Dp = 44.dp, radius: Dp = 14.dp, fill: Boolean = false, size: TextUnit = 15.sp, pad: Dp = 16.dp) {
    PillRow(
        options.size, options.indexOfFirst { it.on }, { options.getOrNull(it)?.onClick?.invoke() },
        modifier.clip(RoundedCornerShape(radius)).background(well).padding(4.dp), radius = radius - 4.dp, fill = fill,
    ) { i, onPill, m ->
        val o = options[i]
        Row(m.height(height).padding(horizontal = if (fill) 6.dp else pad), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            T(o.label, size, 700, if (onPill) V.OnText else V.Dim)
            if (o.sub != null) { Spacer(Modifier.width(8.dp)); T(o.sub, 12.sp, 700, if (onPill) V.OnSub else V.Text3) }
        }
    }
}

// minus, a number, plus
@Composable
fun Stepper(value: String, sub: String? = null, key: Dp = 38.dp, well: Color = V.Well, width: Dp = 50.dp, big: TextUnit = 17.sp, onDown: () -> Unit, onUp: () -> Unit) {
    Row(Modifier.clip(RoundedCornerShape(12.dp)).background(well).padding(3.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        Box(Modifier.size(key).clip(RoundedCornerShape(9.dp)).background(V.Key).clickable(onClick = onDown), contentAlignment = Alignment.Center) { T("−", 20.sp, 700) }
        Column(Modifier.width(width), horizontalAlignment = Alignment.CenterHorizontally) {
            T(value, big, 800)
            if (sub != null) T(sub.uppercase(), 10.sp, 700, V.Text2, spacing = 0.6.sp)
        }
        Box(Modifier.size(key).clip(RoundedCornerShape(9.dp)).background(V.Key).clickable(onClick = onUp), contentAlignment = Alignment.Center) { T("+", 20.sp, 700) }
    }
}

// a rounded label on a wash: "Paid", "Takeaway", "Confirmed"
@Composable
fun Chip(text: String, bg: Color, fg: Color, height: Dp = 24.dp, radius: Dp = 7.dp, size: TextUnit = 12.sp, weight: Int = 700, pad: Dp = 9.dp) {
    Box(Modifier.height(height).clip(RoundedCornerShape(radius)).background(bg).padding(horizontal = pad), contentAlignment = Alignment.Center) {
        T(text, size, weight, fg)
    }
}

// a count on a nav key
@Composable
fun Badge(n: Int, bg: Color, size: Dp = 20.dp) {
    Box(Modifier.heightIn(min = size).widthIn(min = size).clip(RoundedCornerShape(size / 2)).background(bg).padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
        T(n.toString(), 12.sp, 800, Color.White)
    }
}

// The name and the mark, as on the top bar.
@Composable
fun Wordmark() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        // the logo's own mark (the hand holding a note), as it was sent
        androidx.compose.foundation.Image(
            androidx.compose.ui.res.painterResource(com.restopos.app.R.drawable.logo_mark), contentDescription = null,
            modifier = Modifier.height(36.dp), contentScale = androidx.compose.ui.layout.ContentScale.Fit,
        )
        Spacer(Modifier.width(9.dp))
        Text("Easy", color = V.Text, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.4).sp)
        Text("Pay", color = Color(0xFF74B884), fontSize = 20.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.4).sp)
    }
}

// A screen's heading: a quiet line above a large title.
@Composable
fun ScreenHead(sub: String, title: String, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        T(sub, 13.sp, 500, V.Text2)
        T(title, 26.sp, 700, V.Text, spacing = (-0.6).sp)
    }
}

// A text box in the design's style. onDone runs when the keyboard's Done is
// pressed; the caller saves there (and on every change, if it wants to).
@Composable
fun Field(
    value: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier, height: Dp = 46.dp, bg: Color = V.Well,
    number: Boolean = false, phone: Boolean = false, size: TextUnit = 15.sp, leading: (@Composable () -> Unit)? = null, onDone: (() -> Unit)? = null,
) {
    val focus = LocalFocusManager.current
    Row(
        modifier.height(height).clip(RoundedCornerShape(10.dp)).background(bg).border(1.dp, V.Stroke, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) { leading(); Spacer(Modifier.width(10.dp)) }
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty()) T(placeholder, size, 400, V.Text3)
            BasicTextField(
                value, onChange, Modifier.fillMaxWidth(), singleLine = true,
                textStyle = TextStyle(color = V.Text, fontSize = size, fontWeight = FontWeight.Medium),
                cursorBrush = SolidColor(V.Blue),
                keyboardOptions = KeyboardOptions(
                    keyboardType = if (number) KeyboardType.Number else if (phone) KeyboardType.Phone else KeyboardType.Text, imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); onDone?.invoke() }),
            )
        }
    }
}

// A dialog in the design's style: a dark card on a scrim. Tapping the scrim closes it.
// top: the sheet is typed into with the tablet's keyboard, so it sits at the
// top of the screen, where the keyboard that opens does not cover its keys.
@Composable
fun Sheet(onDismiss: () -> Unit, width: Dp = 580.dp, pad: Dp = 26.dp, gap: Dp = 20.dp, top: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().quietTap(onDismiss).padding(top = if (top) 28.dp else 0.dp), contentAlignment = if (top) Alignment.TopCenter else Alignment.Center) {
            Column(
                Modifier.widthIn(max = width).fillMaxWidth(0.92f).heightIn(max = 660.dp).shadow(24.dp, RoundedCornerShape(20.dp))
                    .clip(RoundedCornerShape(20.dp)).background(V.Panel).border(1.dp, V.Stroke, RoundedCornerShape(20.dp))
                    .quietTap {}.verticalScroll(rememberScrollState()).padding(pad),
                verticalArrangement = Arrangement.spacedBy(gap), content = content,
            )
        }
    }
}

// The top of a sheet: what it is, a line under it, and a key to close it.
@Composable
fun SheetHead(title: String, sub: String? = null, onClose: () -> Unit) {
    Row(verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(title, 24.sp, 800, spacing = (-0.4).sp, lines = 2)
            if (sub != null) T(sub, 15.sp, 700, V.Text2, lines = 3)
        }
        Spacer(Modifier.width(12.dp))
        IconKey(VI.Close, onClick = onClose)
    }
}

// What the till says after something was done: a light pill at the bottom of
// the screen that goes away by itself. One at a time; a new one replaces the old.
object Toaster {
    private val _text = MutableStateFlow<Pair<String, Long>?>(null)
    val text: StateFlow<Pair<String, Long>?> = _text
    fun say(message: String?) { if (!message.isNullOrBlank()) _text.value = message to System.nanoTime() }
    fun clear() { _text.value = null }
}

@Composable
fun BoxScope.ToastHost() {
    val t by Toaster.text.collectAsState()
    val now = t ?: return
    LaunchedEffect(now) { delay(if (now.first.length > 60) 4200 else 2800); Toaster.clear() }
    Row(
        Modifier.align(Alignment.BottomCenter).padding(bottom = 28.dp, start = 40.dp, end = 40.dp).shadow(12.dp, RoundedCornerShape(14.dp))
            .clip(RoundedCornerShape(14.dp)).background(V.On).quietTap { Toaster.clear() }.padding(horizontal = 22.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(V.Ok))
        Spacer(Modifier.width(10.dp))
        T(now.first, 15.sp, 700, V.OnText, lines = 3)
    }
}

// A switch as the design draws it.
@Composable
fun Toggle(on: Boolean) {
    Box(Modifier.width(50.dp).height(29.dp).clip(RoundedCornerShape(15.dp)).background(if (on) V.Ok else V.Stroke2)) {
        Box(Modifier.padding(start = if (on) 24.dp else 3.dp, top = 3.dp).size(23.dp).shadow(1.dp, CircleShape).clip(CircleShape).background(Color.White))
    }
}

// a card on the screen: panel colour, hairline, rounded
fun Modifier.panel(radius: Dp = 20.dp): Modifier =
    clip(RoundedCornerShape(radius)).background(V.Panel).border(1.dp, V.Stroke, RoundedCornerShape(radius))

@Composable
fun RowScope.Gap() { Spacer(Modifier.weight(1f)) }
