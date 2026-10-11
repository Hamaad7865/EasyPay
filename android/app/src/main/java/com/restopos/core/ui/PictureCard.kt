package com.restopos.core.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.sp

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

// How wide a card's picture is for its height. The product's sheet shows a
// picture in this shape too, so what is seen there is what the card shows.
// Twice as wide as high: the lowest screen the till is drawn for (1067 x 600)
// then shows two whole rows of cards, on a shop's Sell and on the menu. At
// 16:9 the second row's prices were under the edge.
const val PICTURE_SHAPE = 2f

// Whether any of the products a grid shows has a picture. Then each of its
// cards carries a band (PictureBand), the ones without a picture too: cards
// of two heights side by side leave holes in the rows. A grid with no picture
// in it keeps its cards as low as they were.
@Composable
fun <T> anyPictured(items: List<T>, id: (T) -> String): Boolean {
    val stamps = LocalPictureStamps.current
    return remember(items, stamps) { stamps.isNotEmpty() && items.any { id(it) in stamps } }
}

// The picture along the top of a card, cropped to fill its shape, with the
// name and the price under it on the card's own ground. The owner, of the
// picture behind the words that came first: "right now I think it's blended
// in". Put first in the card, inside its clip and outside its padding.
// A product with no picture shows its initials on `ground` instead; one whose
// picture is still being read shows the ground alone for that moment, so the
// card has its height from the start. off: not to be had (sold out, not on
// sale), the picture grey and faint.
@Composable
fun PictureBand(item: String, name: String, ground: Color, off: Boolean = false) {
    val img = pictureOf(item)
    Box(Modifier.fillMaxWidth().aspectRatio(PICTURE_SHAPE).background(ground), contentAlignment = Alignment.Center) {
        if (img != null) {
            Image(
                img, null, Modifier.matchParentSize(), contentScale = ContentScale.Crop, alpha = if (off) 0.45f else 1f,
                colorFilter = if (off) ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) }) else null,
            )
        } else if (item !in LocalPictureStamps.current) T(initials(name), 22.sp, 800, V.Text3)
    }
}

// What stands for a product that has no picture: the first letter of its
// first two words ("Chicken burger": CB), or the first two of its only one
// ("Coke": Co). Brackets, dashes and the like are not letters of a word.
fun initials(name: String): String {
    val words = name.split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }
    fun first(word: String, n: Int) = word.substring(0, word.offsetByCodePoints(0, minOf(n, word.codePointCount(0, word.length))))
    return when {
        words.isEmpty() -> ""
        words.size == 1 -> first(words[0], 2).replaceFirstChar { it.uppercase() }
        else -> (first(words[0], 1) + first(words[1], 1)).uppercase()
    }
}
