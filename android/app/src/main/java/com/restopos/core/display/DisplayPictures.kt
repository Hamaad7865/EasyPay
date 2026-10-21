package com.restopos.core.display

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import com.restopos.core.common.Uuid7
import com.restopos.core.data.Pictures
import com.restopos.core.database.DisplayPictureEntity
import com.restopos.core.database.TillDatabase
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import javax.inject.Inject
import javax.inject.Singleton

// The pictures a customer display shows in turn, picked on this till: kept
// in the till's database (DisplayPictureEntity), at most 5 for each display,
// each made small enough to travel to a Wi-Fi display in one message.
@Singleton
class DisplayPictures @Inject constructor(
    private val db: TillDatabase,
    @ApplicationContext private val context: Context,
) {
    fun of(owner: String): Flow<List<DisplayPictureEntity>> = db.displayPictures().of(owner)
    suspend fun all(owner: String): List<DisplayPictureEntity> = db.displayPictures().all(owner)

    // A picture from the tablet's photos, for `owner`; a reason in words when it cannot be.
    suspend fun add(owner: String, from: Uri): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val held = db.displayPictures().all(owner)
            require(held.size < MOST) { "A display shows $MOST pictures at most. Take one off first." }
            val jpeg = shrink(Pictures.readTurned(context, from, LONG_SIDE))
            val hash = DisplayWire.hash(jpeg)
            require(held.none { it.hash == hash }) { "That picture is on this display already." }
            db.displayPictures().put(DisplayPictureEntity(Uuid7.next(), owner, jpeg, hash, (held.maxOfOrNull { it.sort_order } ?: -1) + 1))
        }
    }

    suspend fun remove(id: String) = withContext(Dispatchers.IO) { db.displayPictures().drop(id) }

    // At most LONG_SIDE pixels on its long side, and at most MAX_BYTES as a
    // JPEG (base64 makes it a third larger, and a display takes a line of 256 KB).
    private fun shrink(read: Bitmap): ByteArray {
        val (w, h) = Pictures.fit(read.width, read.height, LONG_SIDE)
        var b = if (w == read.width && h == read.height) read else Bitmap.createScaledBitmap(read, w, h, true)
        var quality = 82
        while (true) {
            val out = ByteArrayOutputStream()
            b.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (out.size() <= MAX_BYTES) return out.toByteArray()
            if (quality > 50) quality -= 12
            else b = Bitmap.createScaledBitmap(b, maxOf(1, b.width * 3 / 4), maxOf(1, b.height * 3 / 4), true)
        }
    }

    companion object {
        const val MOST = 5
        const val LONG_SIDE = 1280
        const val MAX_BYTES = 150_000
        // the pictures of the screen joined to this tablet by a cable
        const val CABLE = "cable"
    }
}
