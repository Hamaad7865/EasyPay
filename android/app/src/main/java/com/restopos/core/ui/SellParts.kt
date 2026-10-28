package com.restopos.core.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// What the two selling screens share, a shop's Sell (feature/retail/RetailSell)
// and a restaurant's order screen (feature/order/OrderScreen), laid out after
// the board the owner approved: the categories in a list down the side of the
// products, the sale on the right, and under it its total, then Fast and Pay.
// The owner, of that board: "our theme and accent remains the same it's just
// the layout for selling". So these are the till's own keys and colours.

object SellFit {
    // The 10-inch (core/ui/ScreenFit), where the screens have about 1067 x 600 dp:
    // the list of categories and the sale are narrower, and the products have
    // three cards to a row instead of four.
    fun narrow(width: Dp): Boolean = width < 1200.dp
    fun rail(narrow: Boolean): Dp = if (narrow) 148.dp else 172.dp
    fun sale(narrow: Boolean): Dp = if (narrow) 360.dp else 400.dp
    fun fast(narrow: Boolean): Dp = if (narrow) 92.dp else 108.dp
}

// The categories, down the side of the products.
@Composable
fun Rail(width: Dp, content: LazyListScope.() -> Unit) {
    LazyColumn(
        Modifier.width(width).fillMaxHeight().clip(RoundedCornerShape(18.dp)).background(V.Panel),
        contentPadding = PaddingValues(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp), content = content,
    )
}

// One category in the list: lit as the till lights what is picked (V.On), with
// how many products it holds, and for a restaurant its colour. indent: one
// under the top one that is open ("All Shirt", Long Sleeve), set further in.
@Composable
fun RailKey(label: String, count: Int?, on: Boolean, dot: Color? = null, indent: Boolean = false, onClick: () -> Unit) {
    val bg by animateColorAsState(if (on) V.On else Color.Transparent, tween(160), label = "rail")
    val fg by animateColorAsState(if (on) V.OnText else V.Text2, tween(160), label = "railName")
    Row(
        Modifier.fillMaxWidth().heightIn(min = 50.dp).press(0.98f, onClick).clip(RoundedCornerShape(12.dp)).background(bg)
            .padding(start = if (indent) 28.dp else 14.dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        dot?.let { Box(Modifier.size(9.dp).clip(CircleShape).background(it)) }
        T(label, 15.sp, 700, fg, Modifier.weight(1f), lines = 2, height = 18.sp)
        count?.let { T(it.toString(), 12.sp, 600, if (on) V.OnText.copy(alpha = 0.6f) else V.Text3) }
    }
}

// What the sale comes to, large, with how many things are on it.
@Composable
fun TotalRow(label: String, count: Int, amount: String, low: Boolean) {
    Row(verticalAlignment = Alignment.Bottom) {
        T(label, 17.sp, 800)
        if (count > 0) {
            Spacer(Modifier.width(6.dp))
            T(if (count == 1) "1 item" else "$count items", 13.sp, 600, V.Text3, Modifier.padding(bottom = 1.dp))
        }
        Spacer(Modifier.weight(1f))
        T(amount, if (low) 24.sp else 28.sp, 800, spacing = (-0.6).sp)
    }
}

// Fast: the whole sale paid in cash, the exact amount, in one tap
// (PayViewModel.fast). In the till's own green, quieter than Pay beside it.
@Composable
fun RowScope.FastKey(live: Boolean, width: Dp, onClick: () -> Unit) {
    val ink = if (live) V.GreenText else V.Off
    Column(
        Modifier.width(width).fillMaxHeight().press(onClick = onClick).clip(RoundedCornerShape(16.dp))
            .background(if (live) V.GreenWash else Color.Transparent).border(1.5.dp, if (live) V.GreenText else V.Stroke2, RoundedCornerShape(16.dp)),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        T(L.fast, 18.sp, 800, ink)
        T(L.exactCash, 11.5.sp, 700, ink.copy(alpha = 0.85f))
    }
}

// Pay: the payment screen, as before.
@Composable
fun RowScope.PayKey(label: String, live: Boolean, onClick: () -> Unit) {
    val ink = if (live) V.GreenInk else V.GreenOffText
    Row(
        Modifier.weight(1f).fillMaxHeight().press(onClick = onClick).clip(RoundedCornerShape(16.dp)).background(if (live) V.Green else V.GreenOff)
            .padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
    ) {
        T(label, 20.sp, 800, ink)
        Spacer(Modifier.width(6.dp))
        VIcon(VI.Chevron, 20.dp, ink, 3f)
    }
}

// The row Fast and Pay stand in, at the foot of the sale.
@Composable
fun GoRow(low: Boolean, content: @Composable RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth().height(if (low) 56.dp else 62.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), content = content)
}
