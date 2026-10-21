package com.restopos.core.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.restopos.core.database.ItemPictureEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.ui.PictureSource
import com.restopos.core.ui.Toaster
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import javax.inject.Inject
import javax.inject.Singleton

// The pictures on the till's product cards. The owner: "the cards on the
// tills that shows the product should be able to support picture as well".
//
// A picture is chosen from the tablet's gallery or taken with its camera, on
// the product's sheet. It is made small here (a card is a few centimetres
// wide: a photograph of twelve megapixels would be read and thrown away on
// every card) and kept in the till's database, so a backup carries it. It is
// this tablet's: nothing sends it anywhere, so another till of the same
// business does not have it, and a tablet that works on its own needs
// nothing but itself for it.
@Singleton
class Pictures @Inject constructor(
    @ApplicationContext private val context: Context,
    private val db: TillDatabase,
) : PictureSource {
    // its own: a picture chosen as the sheet closes is still saved
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    // decoded pictures, the last used kept: a grid scrolled back to is drawn at once
    private val held = LruCache<String, ImageBitmap>(80)

    // which products have a picture, and when each was set
    val stamps: Flow<Map<String, Long>> = db.pictures().stamps().map { rows -> rows.associate { it.item_id to it.updated_at } }

    override fun held(item: String, stamp: Long): ImageBitmap? = held.get("$item@$stamp")
    override suspend fun of(item: String, stamp: Long): ImageBitmap? = held(item, stamp) ?: withContext(Dispatchers.Default) {
        runCatching {
            val jpeg = db.pictures().jpeg(item) ?: return@runCatching null
            BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)?.asImageBitmap()?.also { held.put("$item@$stamp", it) }
        }.getOrNull()
    }

    // A picture picked on the tablet, or the photograph its camera has just
    // written to a file of the till's own: read, turned the way it was taken,
    // made small, kept.
    fun choose(item: String, from: Uri) = keep(item) { readTurned(context, from, MOST) }

    fun remove(item: String) = scope.launch { runCatching { db.pictures().drop(item) } }

    private fun keep(item: String, read: () -> Bitmap) = scope.launch {
        runCatching {
            val small = small(read())
            val out = ByteArrayOutputStream()
            small.compress(Bitmap.CompressFormat.JPEG, 82, out)
            db.pictures().put(ItemPictureEntity(item, out.toByteArray(), System.currentTimeMillis()))
        }.onFailure { Toaster.say(it.message?.takeIf { m -> m.length < 120 } ?: "That picture could not be used. Try another.") }
    }

    private fun small(b: Bitmap): Bitmap {
        val (w, h) = fit(b.width, b.height, MOST)
        return if (w == b.width && h == b.height) b else Bitmap.createScaledBitmap(b, w, h, true)
    }

    companion object {
        // the long side of a kept picture, in pixels: twice a card's width on the sharpest tablet the till is drawn for
        const val MOST = 640

        // A picture chosen on the tablet, read at a fraction of its size when
        // it is far larger than `most` needs (a whole photograph does not fit
        // a small tablet's memory), and turned the way it was taken. Also the
        // customer display's pictures (core/display/DisplayPictures).
        fun readTurned(context: android.content.Context, from: Uri, most: Int): Bitmap {
            val resolver = context.contentResolver
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            // Asked for its size alone, Android hands back no picture, by design: only a file that
            // cannot be opened is refused here. (Until 2026-10-21 that empty answer was taken for one,
            // so a picture chosen from the tablet's photos was always refused.)
            val stream = resolver.openInputStream(from) ?: error("That picture could not be opened.")
            stream.use { BitmapFactory.decodeStream(it, null, bounds) }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) error("That file is not a picture this tablet can read.")
            val opts = BitmapFactory.Options().apply { inSampleSize = sample(bounds.outWidth, bounds.outHeight, most) }
            val read = resolver.openInputStream(from)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: error("That picture could not be read.")
            val turn = runCatching { resolver.openInputStream(from)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } }.getOrNull()
            val degrees = when (turn) { ExifInterface.ORIENTATION_ROTATE_90 -> 90f; ExifInterface.ORIENTATION_ROTATE_180 -> 180f; ExifInterface.ORIENTATION_ROTATE_270 -> 270f; else -> 0f }
            return if (degrees == 0f) read else Bitmap.createBitmap(read, 0, 0, read.width, read.height, Matrix().apply { postRotate(degrees) }, true)
        }

        // The size a picture is kept at: its own shape, its long side MOST at
        // most. One that is smaller already is left as it is.
        fun fit(w: Int, h: Int, most: Int): Pair<Int, Int> {
            if (w <= 0 || h <= 0) return 1 to 1
            val long = maxOf(w, h)
            if (long <= most) return w to h
            return maxOf(1, Math.round(w.toFloat() * most / long)) to maxOf(1, Math.round(h.toFloat() * most / long))
        }

        // By how much a picture is read smaller than it is (2, 4, 8…): the
        // largest that still leaves its long side at `most` or more.
        fun sample(w: Int, h: Int, most: Int): Int {
            var by = 1
            while (maxOf(w, h) / (by * 2) >= most) by *= 2
            return by
        }
    }
}
