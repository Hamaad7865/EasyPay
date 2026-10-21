package com.restopos.feature.display

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Money
import com.restopos.core.display.PicLine
import com.restopos.core.display.Picture
import com.restopos.core.ui.L
import com.restopos.core.ui.T
import com.restopos.core.ui.Wordmark
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// What the customer sees, drawn from a picture alone: the same screen on a
// tablet set up as a customer display (DisplayMode, over the Wi-Fi) and on a
// second screen joined to the till by a cable (CableDisplay). Laid out after
// a shop's display the owner sent: the business's name on top, the sale as a
// table (Description, Qty, Price, Disc%, Amount), the figures under it
// (Total, Discount, VAT, Payment, Balance, Total quantity), the logo and the
// shop's pictures in turn on the right, today's date at the foot.
//
// Its colours are its own, light unless asked dark: on a cable screen it is
// drawn beside the till's, whose own setting (Pos.light) is the cashier's.
@Composable
fun CustomerScreen(p: Picture, logo: ImageBitmap?, pictures: List<ImageBitmap> = emptyList(), modifier: Modifier = Modifier, light: Boolean = true) {
    // the words follow the till's language
    LaunchedEffect(p.lang) { L.lang = p.lang }
    CompositionLocalProvider(LocalInk provides Ink(light)) { Screen(p, logo, pictures, modifier) }
}

// The customer display's colours, as the till's own (V2), light or dark.
internal class Ink(light: Boolean) {
    private val l = light
    private fun c(dark: Long, bright: Long) = Color(if (l) bright else dark)
    val bg = c(0xFF131519, 0xFFEEF0F4)
    val panel = c(0xFF1B1E24, 0xFFFFFFFF)
    val well = c(0xFF131519, 0xFFE9EBF0)
    val stroke = c(0xFF2B3039, 0xFFD9DCE4)
    val rowLine = c(0xFF252932, 0xFFE4E7ED)
    val text = c(0xFFF2F4F7, 0xFF1A1C21)
    val text2 = c(0xFFA6AEBB, 0xFF4B5261)
    val text3 = c(0xFF79818F, 0xFF7A8191)
    val green = c(0xFF2BD48A, 0xFF0F8050)
}

private val LocalInk = staticCompositionLocalOf { Ink(true) }
private val ink: Ink @Composable @ReadOnlyComposable get() = LocalInk.current

// T in the display's own colours
@Composable
private fun Tx(
    text: String, size: TextUnit = 15.sp, weight: Int = 700, color: Color = ink.text, modifier: Modifier = Modifier,
    lines: Int = 1, align: TextAlign? = null, spacing: TextUnit = TextUnit.Unspecified, height: TextUnit = TextUnit.Unspecified,
) = T(text, size, weight, color, modifier, lines, align, spacing, height)

@Composable
private fun Screen(p: Picture, logo: ImageBitmap?, pictures: List<ImageBitmap>, modifier: Modifier) {
    Box(modifier.fillMaxSize().background(ink.bg)) {
        if (p.state == Picture.IDLE) Idle(p, logo, pictures)
        else Column(Modifier.fillMaxSize()) {
            Head(p.business.ifBlank { p.title })
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp)) {
                val wide = maxWidth > maxHeight * 1.1f
                val band = maxHeight * 0.28f
                if (wide) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    Sale(p, Modifier.weight(1.65f).fillMaxHeight())
                    Side(logo, pictures, Modifier.weight(1f).fillMaxHeight())
                } else Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Sale(p, Modifier.weight(1f).fillMaxWidth())
                    if (logo != null || pictures.isNotEmpty()) Side(logo, pictures, Modifier.fillMaxWidth().height(band))
                }
            }
            Foot()
        }
    }
}

// The display's own words, in the till's language (the picture says which).
internal object W {
    val description get() = L.t("Description", "Article", "Lartik")
    val qty get() = L.t("Qty", "Qté", "Kt")
    val price get() = L.t("Price", "Prix", "Pri")
    val disc get() = L.t("Disc%", "Rem%", "Rem%")
    val amount get() = L.t("Amount", "Montant", "Montan")
    val total get() = L.t("Total", "Total", "Total")
    val discount get() = L.t("Discount", "Remise", "Remiz")
    val vat get() = L.t("VAT", "TVA", "TVA")
    val vatIncluded get() = L.t("VAT included", "TVA incluse", "TVA inkli")
    val service get() = L.t("Service", "Service", "Servis")
    val rounding get() = L.t("Rounding", "Arrondi", "Larondisman")
    val payment get() = L.t("Payment", "Paiement", "Peyman")
    val balance get() = L.t("Balance", "Reste à payer", "Reste pou peye")
    val change get() = L.t("Change", "Monnaie", "Lamonnen")
    val quantity get() = L.t("Total quantity", "Quantité totale", "Kantite total")
    val thanks get() = L.t("Thank you", "Merci", "Mersi")
    val welcome get() = L.t("Welcome", "Bienvenue", "Byenveni")
}

// A logo or a picture kept as a data URL ("data:image/png;base64,...") as an image, or null.
fun decodePicture(data: String?): ImageBitmap? = data?.let {
    runCatching {
        val bytes = android.util.Base64.decode(it.substringAfter(','), android.util.Base64.DEFAULT)
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    }.getOrNull()
}

// "1,250.00" with the decimals the business shows; "Rs 1,250.00" with `rs`
internal fun money(cents: Long, places: Int, rs: Boolean = false): String =
    (if (cents < 0) "-" else "") + (if (rs) "Rs " else "") + Money.plain(Math.abs(cents), places)

@Composable
private fun Head(name: String) {
    Box(Modifier.fillMaxWidth().background(ink.panel).padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
        Tx(name, 22.sp, 800, lines = 1, align = TextAlign.Center)
    }
}

// today, as a customer reads it: "Wednesday 21 October 2026", in the till's language
@Composable
private fun Foot() {
    val locale = if (L.fr) Locale.FRENCH else Locale.UK
    val today = remember(L.lang) { SimpleDateFormat("EEEE d MMMM yyyy", locale).format(Date()).replaceFirstChar { it.uppercase() } }
    Box(Modifier.fillMaxWidth().background(ink.panel).padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        Tx(today, 16.sp, 700, ink.text2)
    }
}

// The table of lines, then the figures; after Pay the change and thanks.
@Composable
private fun Sale(p: Picture, modifier: Modifier) {
    val list = rememberLazyListState()
    // the newest line is always in view
    LaunchedEffect(p.lines.size) { if (p.lines.isNotEmpty()) list.animateScrollToItem(p.lines.size - 1) }
    Column(modifier.clip(RoundedCornerShape(18.dp)).background(ink.panel).border(1.dp, ink.stroke, RoundedCornerShape(18.dp)).padding(horizontal = 18.dp, vertical = 12.dp)) {
        if (p.title.isNotBlank() && p.business.isNotBlank()) Tx(p.title, 14.sp, 700, ink.text3, Modifier.padding(bottom = 6.dp))
        Row(Modifier.fillMaxWidth().background(ink.well, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 6.dp)) {
            Cell(W.description, Modifier.weight(3f), ink.text2, 14.sp, 700)
            Cell(W.qty, Modifier.weight(0.7f), ink.text2, 14.sp, 700, end = true)
            Cell(W.price, Modifier.weight(1.3f), ink.text2, 14.sp, 700, end = true)
            Cell(W.disc, Modifier.weight(0.8f), ink.text2, 14.sp, 700, end = true)
            Cell(W.amount, Modifier.weight(1.4f), ink.text2, 14.sp, 700, end = true)
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list) {
            itemsIndexed(p.lines) { i, l ->
                if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(ink.rowLine))
                LineRow(l, p.decimals)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(ink.stroke))
        Figures(p)
    }
}

@Composable
private fun LineRow(l: PicLine, places: Int) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 9.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(3f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Tx(l.name, 18.sp, 700, lines = 2, height = 23.sp)
            if (l.detail.isNotBlank()) Tx(l.detail, 14.sp, 500, ink.text2, lines = 2, height = 18.sp)
        }
        Cell(l.qty, Modifier.weight(0.7f), ink.text, 18.sp, 700, end = true)
        // a version 1 till sends no price: the amount alone
        Cell(if (l.price > 0) money(l.price, places) else "", Modifier.weight(1.3f), ink.text2, 16.sp, 600, end = true)
        Cell(if (l.price > 0) l.off.toString() else "", Modifier.weight(0.8f), if (l.off > 0) ink.green else ink.text2, 16.sp, 600, end = true)
        Cell(money(l.amount, places), Modifier.weight(1.4f), ink.text, 18.sp, 700, end = true)
    }
}

@Composable
private fun Cell(text: String, modifier: Modifier, color: androidx.compose.ui.graphics.Color, size: TextUnit, weight: Int, end: Boolean = false) {
    Tx(text, size, weight, color, modifier, lines = 1, align = if (end) TextAlign.End else TextAlign.Start)
}

// Every figure the receipt has, adding up to the balance (Pictures.sale).
@Composable
private fun ColumnScope.Figures(p: Picture) {
    val d = p.decimals
    val paid = p.state == Picture.PAID
    Column(Modifier.fillMaxWidth().padding(top = 10.dp, start = 8.dp, end = 8.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        // a version 1 till sends none of these: its total stands for them
        val gross = if (p.gross > 0) p.gross else p.total
        Figure(W.total, money(gross, d))
        Figure(W.discount, money(p.discount, d))
        if (p.service != 0L) Figure(W.service, money(p.service, d))
        if (p.rounding != 0L) Figure(W.rounding, money(p.rounding, d))
        Figure(if (p.vatAdded > 0) W.vat else W.vatIncluded, money(p.vat, d))
        Figure(W.payment, money(p.paid, d))
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Tx(if (paid) W.change else W.balance, 22.sp, 800, if (paid) ink.green else ink.text, Modifier.weight(1f))
            Tx(money(if (paid) p.change else p.left, d, rs = true), 40.sp, 800, if (paid) ink.green else ink.text, spacing = (-1).sp)
        }
        if (p.quantity > 0) Figure(W.quantity, p.quantity.toString())
        if (paid) Tx(W.thanks, 22.sp, 800, modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 4.dp))
    }
}

@Composable
private fun Figure(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Tx(label, 16.sp, 600, ink.text2, Modifier.weight(1f))
        Tx(value, 16.sp, 700)
    }
}

// The logo, then the shop's pictures in turn (8 seconds each).
@Composable
private fun Side(logo: ImageBitmap?, pictures: List<ImageBitmap>, modifier: Modifier) {
    Column(
        modifier.clip(RoundedCornerShape(18.dp)).background(ink.panel).border(1.dp, ink.stroke, RoundedCornerShape(18.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (logo != null) Image(logo, null, Modifier.heightIn(max = 110.dp).widthIn(max = 260.dp), contentScale = ContentScale.Fit)
        if (pictures.isNotEmpty()) Turning(pictures, Modifier.weight(1f).fillMaxWidth())
        else if (logo == null) Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { Wordmark() }
    }
}

@Composable
private fun Turning(pictures: List<ImageBitmap>, modifier: Modifier) {
    var at by remember(pictures.size) { mutableIntStateOf(0) }
    LaunchedEffect(pictures.size) {
        while (pictures.size > 1) {
            delay(TURN_MS)
            at = (at + 1) % pictures.size
        }
    }
    Crossfade(pictures[at.coerceIn(0, pictures.size - 1)], modifier.clip(RoundedCornerShape(12.dp)), animationSpec = tween(700), label = "pictures") { pic ->
        Image(pic, null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
    }
}

// Between sales: the shop's pictures large, with the logo, name and message
// beside them; without pictures, the logo, name and message alone.
@Composable
private fun Idle(p: Picture, logo: ImageBitmap?, pictures: List<ImageBitmap>) {
    val message = p.message.lines().map { it.trim() }.filter { it.isNotEmpty() }
    val words: @Composable (Float) -> Unit = { scale ->
        if (logo != null) Image(logo, null, Modifier.heightIn(max = (170 * scale).dp).widthIn(max = (340 * scale).dp), contentScale = ContentScale.Fit)
        if (p.business.isNotBlank()) Tx(p.business, (42 * scale).sp, 800, lines = 2, align = TextAlign.Center, spacing = (-0.8).sp, height = (48 * scale).sp)
        else if (logo == null) Wordmark()
        if (message.isEmpty()) Tx(W.welcome, (24 * scale).sp, 600, ink.text2)
        else message.forEach { Tx(it, (24 * scale).sp, 600, ink.text2, lines = 2, align = TextAlign.Center, height = (31 * scale).sp) }
    }
    if (pictures.isEmpty()) Column(Modifier.fillMaxSize().padding(40.dp), verticalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
        words(1f)
    } else BoxWithConstraints(Modifier.fillMaxSize().padding(20.dp)) {
        if (maxWidth > maxHeight * 1.1f) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            Turning(pictures, Modifier.weight(1.7f).fillMaxHeight())
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) { words(0.75f) }
        } else Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Turning(pictures, Modifier.weight(1f).fillMaxWidth())
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp), horizontalAlignment = Alignment.CenterHorizontally) { words(0.7f) }
            Spacer(Modifier.width(1.dp))
        }
    }
}

private const val TURN_MS = 8_000L
