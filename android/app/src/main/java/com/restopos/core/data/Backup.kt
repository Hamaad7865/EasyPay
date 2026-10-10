package com.restopos.core.data

import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import androidx.room.withTransaction
import com.restopos.app.BuildConfig
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.time.LocalDate
import javax.inject.Inject
import javax.inject.Singleton

// A backup of this tablet, saved where the owner says (a USB stick, the
// tablet's Downloads, a Drive), and a tablet filled from one.
//
// What a backup holds: the till's database (the menu, the staff, every sale
// and receipt, what is still to be sent the day the business is connected)
// and what the tablet knows of itself (which business, store and till it
// is). Not the sign-in: a tablet filled from a backup works on its own at
// once, and signs in once more the day it is connected to the cloud.
//
// Restoring is offered only on a tablet that is not set up yet, so it never
// replaces anything: a tablet with sales on it is not written over. The
// files are put in a waiting place and the app starts again; they are moved
// into place before anything opens them (applyWaiting, from the app's start).
@Singleton
class Backup @Inject constructor(
    @ApplicationContext private val context: Context,
    private val db: TillDatabase,
    private val session: SessionStore,
) {
    fun name(business: String?): String = BackupFile.name(business ?: "", LocalDate.now().toString())

    // Saves a backup to the place picked. Returns how large it is, in bytes.
    suspend fun save(to: Uri): Result<Long> = withContext(Dispatchers.IO) {
        runCatching {
            val file = context.getDatabasePath(DB)
            // what the database has not yet folded into its file is folded in first, as far as it can be
            runCatching { db.openHelper.writableDatabase.query("PRAGMA wal_checkpoint(TRUNCATE)").use { it.moveToFirst() } }
            val note = BackupFile.Note(
                madeAt = System.currentTimeMillis(), app = BuildConfig.VERSION_NAME, database = db.openHelper.readableDatabase.version,
                business = session.businessName() ?: "", tenant = session.tenantId() ?: "", store = session.storeId() ?: "", device = session.deviceId() ?: "",
            )
            // nothing is written to the database while its files are copied: the copy is of one moment
            db.withTransaction {
                val out = context.contentResolver.openOutputStream(to, "w") ?: error("That place cannot be written to.")
                out.use { BackupFile.write(note, mapOf(DB to file, WAL to File(file.path + "-wal"), PREFS to prefs(context)), it) }
            }
            session.setLastBackup(note.madeAt)
            context.contentResolver.openFileDescriptor(to, "r")?.use { it.statSize } ?: 0L
        }.recoverCatching { throw IllegalStateException(it.message?.takeIf { m -> m.length < 120 } ?: "The backup could not be saved there.") }
    }

    // Reads a backup into the waiting place and says what it is of. Nothing is changed yet.
    suspend fun read(from: Uri): Result<BackupFile.Note> = withContext(Dispatchers.IO) {
        runCatching {
            val wait = waiting(context)
            wait.deleteRecursively()
            val input = context.contentResolver.openInputStream(from) ?: throw BackupFile.NotABackup("That file could not be opened.")
            val note = input.use { BackupFile.read(it, wait, setOf(DB, WAL, PREFS)) }
            val held = File(wait, DB)
            // the version the file itself says, not the note's word for it
            val version = if (held.isFile) runCatching { SQLiteDatabase.openDatabase(held.path, null, SQLiteDatabase.OPEN_READONLY).use { it.version } }.getOrDefault(0) else 0
            // opening it to look may have left files beside it that are not the backup's
            File(held.path + "-shm").delete(); File(held.path + "-journal").delete()
            BackupFile.refusal(note.copy(database = version), db.openHelper.readableDatabase.version, held.isFile && version > 0)?.let {
                wait.deleteRecursively()
                throw BackupFile.NotABackup(it)
            }
            note
        }
    }

    // The backup just read is the one to use: marked, and the app starts again to take it.
    fun restart() {
        File(waiting(context), READY).writeText("1")
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch?.component != null) context.startActivity(Intent.makeRestartActivityTask(launch.component))
        Runtime.getRuntime().exit(0)
    }

    fun forget() { waiting(context).deleteRecursively() }

    companion object {
        private const val DB = "till.db"
        private const val WAL = "till.db-wal"
        private const val PREFS = "device.preferences_pb"
        private const val READY = "ready"
        private fun waiting(context: Context) = File(context.filesDir, "restore")
        private fun prefs(context: Context) = File(context.filesDir, "datastore/$PREFS")

        // Moves a backup that is waiting into place. Called when the app
        // starts, before the database or the settings have been opened by
        // anything. A waiting place with no mark is one that was read and
        // then not used: it is cleared.
        fun applyWaiting(context: Context) {
            val wait = waiting(context)
            if (!wait.isDirectory) return
            runCatching {
                if (File(wait, READY).isFile && File(wait, DB).isFile) {
                    val db = context.getDatabasePath(DB)
                    db.parentFile?.mkdirs()
                    listOf("", "-wal", "-shm", "-journal").forEach { File(db.path + it).delete() }
                    File(wait, DB).copyTo(db, overwrite = true)
                    File(wait, WAL).takeIf { it.isFile }?.copyTo(File(db.path + "-wal"), overwrite = true)
                    File(wait, PREFS).takeIf { it.isFile }?.let { p ->
                        val to = prefs(context)
                        to.parentFile?.mkdirs()
                        p.copyTo(to, overwrite = true)
                    }
                }
            }
            wait.deleteRecursively()
        }
    }
}
