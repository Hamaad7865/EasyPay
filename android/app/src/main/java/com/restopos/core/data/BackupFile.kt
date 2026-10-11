package com.restopos.core.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

// A tablet's backup, as one file: a zip that holds a note of what it is and
// the files the till keeps (its database, and what it knows of itself: which
// business, store and till it is). A tablet that works on its own has
// nothing else between its owner and a broken tablet, so the file is checked
// when it is read as carefully as it is written.
//
// Plain Kotlin and java.util.zip, so that it is tested on the JVM: what a
// tablet writes, a tablet reads back, and anything else is turned away.
object BackupFile {
    const val NOTE = "easypay-backup.json"
    const val KIND = "easypay-till-backup"
    // more than any till's files come to; a file that claims more is not one of ours
    const val MOST = 2L * 1024 * 1024 * 1024

    // What the backup is of. database: the version of the till's database it holds.
    @Serializable
    data class Note(
        // what kind of file this is: written with every backup, and a file whose note does not say it is turned away
        val kind: String = "",
        val madeAt: Long,
        val app: String,
        val database: Int,
        val business: String = "",
        val tenant: String = "",
        val store: String = "",
        val device: String = "",
    )

    class NotABackup(message: String) : Exception(message)

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    // The backup's name: "EasyPay backup Chez Aisha 2026-10-11.easypay"
    fun name(business: String, day: String): String =
        "EasyPay backup " + business.replace(Regex("""[\\/:*?"<>|\p{Cntrl}]"""), " ").trim().ifEmpty { "till" }.take(40) + " " + day + ".easypay"

    // files: what each is called inside the backup, and where it is now. One that is not there is left out.
    fun write(note: Note, files: Map<String, File>, out: OutputStream) {
        ZipOutputStream(out).use { zip ->
            zip.putNextEntry(ZipEntry(NOTE))
            zip.write(json.encodeToString(Note.serializer(), note.copy(kind = KIND)).toByteArray())
            zip.closeEntry()
            for ((name, file) in files) {
                if (!file.isFile) continue
                require(safe(name)) { "not a name for a backup: $name" }
                zip.putNextEntry(ZipEntry(name))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }

    // Reads a backup into an empty folder and says what it is of. Only names
    // the till itself writes are taken (wanted), each as a plain file in that
    // folder: a file made to write somewhere else is not followed there.
    fun read(input: InputStream, into: File, wanted: Set<String>): Note {
        into.mkdirs()
        var note: Note? = null
        var total = 0L
        try {
            ZipInputStream(input).use { zip ->
                while (true) {
                    val e = zip.nextEntry ?: break
                    if (e.isDirectory) continue
                    if (e.name == NOTE) {
                        note = runCatching { json.decodeFromString(Note.serializer(), zip.readBytes().toString(Charsets.UTF_8)) }.getOrNull()
                        continue
                    }
                    if (e.name !in wanted || !safe(e.name)) continue
                    File(into, e.name).outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = zip.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > MOST) throw NotABackup("That file is too large to be a backup.")
                            out.write(buf, 0, n)
                        }
                    }
                }
            }
        } catch (e: NotABackup) {
            throw e
        } catch (e: Exception) {
            throw NotABackup("That file could not be read. It is not an EasyPay backup, or it is damaged.")
        }
        val n = note
        if (n == null || n.kind != KIND) throw NotABackup("That file is not an EasyPay backup.")
        return n
    }

    // a plain file name: no folders, nothing that climbs out
    private fun safe(name: String): Boolean = name.isNotEmpty() && name.length <= 80 && name.none { it == '/' || it == '\\' } && name != "." && name != ".."

    // Whether this build can open what the backup holds, in words when it cannot.
    fun refusal(note: Note, databaseNow: Int, hasDatabase: Boolean): String? = when {
        !hasDatabase -> "That backup holds no till data."
        note.database > databaseNow -> "That backup was made by a newer EasyPay than this one. Update EasyPay on this tablet first, then restore."
        note.database < 1 -> "That file is not an EasyPay backup."
        else -> null
    }
}
