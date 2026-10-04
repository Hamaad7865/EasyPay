package com.restopos.core.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The few pieces the till's lists are built from, so Orders, Receipts and the
// rest look like one product: a card with a hairline edge, a table header in
// small capitals, a tinted tag, an avatar.

val CardShape = RoundedCornerShape(14.dp)

fun Modifier.card(): Modifier = clip(CardShape).background(Pos.Panel).border(1.dp, Pos.Stroke, CardShape)

// A status in its own colour on a wash of that colour.
@Composable
fun Tag(text: String, color: Color, dot: Boolean = false) {
    Row(
        Modifier.clip(RoundedCornerShape(8.dp)).background(color.copy(alpha = 0.15f)).padding(horizontal = 9.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (dot) Box(Modifier.padding(end = 6.dp).size(6.dp).clip(CircleShape).background(color))
        Text(text, color = color, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1)
    }
}

private val AVATARS = listOf(Color(0xFF6C8BFF), Color(0xFF45A85A), Color(0xFFE6B23C), Color(0xFFE2587A), Color(0xFF8A92F7), Color(0xFF2BB5B0))

// The first letter of a name on a colour that is always the same for that name.
@Composable
fun Avatar(name: String, size: Dp = 26.dp) {
    val color = AVATARS[Math.floorMod(name.hashCode(), AVATARS.size)]
    Box(Modifier.size(size).clip(CircleShape).background(color.copy(alpha = 0.22f)), contentAlignment = Alignment.Center) {
        Text(name.trim().take(1).uppercase(), color = color, fontSize = (size.value * 0.46f).sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(Pos.Stroke))
}

// A column heading: small, spaced, quiet. The one the list is sorted by is
// lit and carries an arrow.
@Composable
fun RowScope.HeadCell(label: String, weight: Float, sorted: Boolean = false, descending: Boolean = false, end: Boolean = false, onClick: (() -> Unit)? = null) {
    Text(
        label.uppercase() + if (sorted) (if (descending) "  ↓" else "  ↑") else "",
        Modifier.weight(weight).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = 8.dp, vertical = 14.dp),
        color = if (sorted) Pos.Link else Pos.Text3, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.7.sp,
        maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = if (end) TextAlign.End else TextAlign.Start,
    )
}
