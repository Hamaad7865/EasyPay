package com.restopos.core.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import kotlin.math.roundToInt

// Where a card gets a product's picture from (core/data/Pictures). stamp:
// when the picture was set, so that a changed picture is a new one.
interface PictureSource {
    // already decoded, or null: asked while a card is being drawn, so it must not wait
    fun held(item: String, stamp: Long): ImageBitmap?
    suspend fun of(item: String, stamp: Long): ImageBitmap?
}

// Given once, round the whole till (MainActivity): the pictures, and which
// products have one. A card asks for its own with pictureOf.
val LocalPictures = staticCompositionLocalOf<PictureSource?> { null }
val LocalPictureStamps = staticCompositionLocalOf<Map<String, Long>> { emptyMap() }

// A product's picture, or null when it has none (or while it is being read
// for the first time: the card is drawn without it for that moment).
@Composable
fun pictureOf(item: String): ImageBitmap? {
    val pictures = LocalPictures.current ?: return null
    val stamp = LocalPictureStamps.current[item] ?: return null
    val img by produceState(pictures.held(item, stamp), item, stamp) { value = pictures.of(item, stamp) }
    return img
}

// The picture behind a card: cropped to fill it, whatever the card's shape,
// with a shade over it that deepens towards the foot, where the price is, so
// that white words stay readable on any photograph. Put after the card's
// clip and background and before its padding. No picture: nothing is drawn.
fun Modifier.picture(img: ImageBitmap?): Modifier = if (img == null) this else drawBehind {
    if (img.width <= 0 || img.height <= 0 || size.width <= 0f || size.height <= 0f) return@drawBehind
    val scale = maxOf(size.width / img.width, size.height / img.height)
    val w = (size.width / scale).roundToInt().coerceIn(1, img.width)
    val h = (size.height / scale).roundToInt().coerceIn(1, img.height)
    drawImage(
        img, srcOffset = IntOffset((img.width - w) / 2, (img.height - h) / 2), srcSize = IntSize(w, h),
        dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()),
    )
    drawRect(Brush.verticalGradient(0f to Color.Black.copy(alpha = 0.30f), 0.45f to Color.Black.copy(alpha = 0.38f), 1f to Color.Black.copy(alpha = 0.82f)))
}

// The colours of words over a picture: the same on a light screen and a dark one, since the shade under them is dark on both.
object OverPicture {
    val Text = Color.White
    val Soft = Color.White.copy(alpha = 0.82f)
    val Amber = Color(0xFFFFC15A)
    val Red = Color(0xFFFF8A8E)
}
