package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

// A tablet's backup as a file: what a tablet writes, a tablet reads back; a
// file that is not one of ours, or was made to write somewhere it should
// not, is turned away.
class BackupFileTest {
    @get:Rule val tmp = TemporaryFolder()
    private val note = BackupFile.Note(madeAt = 1_760_000_000_000L, app = "0.9.0", database = 18, business = "Chez Aisha", tenant = "t", store = "s", device = "d")
    private val wanted = setOf("till.db", "till.db-wal", "device.preferences_pb")

    private fun file(name: String, bytes: ByteArray): File = tmp.newFile(name).also { it.writeBytes(bytes) }
    private fun written(files: Map<String, File>): ByteArray = ByteArrayOutputStream().also { BackupFile.write(note, files, it) }.toByteArray()

    @Test fun `what is written is read back, byte for byte`() {
        val db = file("a.db", ByteArray(300_000) { (it * 31).toByte() })
        val prefs = file("a.pb", "who this till is".toByteArray())
        val zip = written(mapOf("till.db" to db, "till.db-wal" to File(tmp.root, "not-there"), "device.preferences_pb" to prefs))
        val into = tmp.newFolder("restore")
        val read = BackupFile.read(ByteArrayInputStream(zip), into, wanted)
        assertEquals(note.copy(kind = BackupFile.KIND), read)
        assertTrue(File(into, "till.db").readBytes().contentEquals(db.readBytes()))
        assertEquals("who this till is", File(into, "device.preferences_pb").readText())
        // a file that was not there when the backup was made is simply not in it
        assertFalse(File(into, "till.db-wal").exists())
    }

    @Test fun `a file that is not a backup is turned away`() {
        val into = tmp.newFolder("r1")
        val notZip = runCatching { BackupFile.read(ByteArrayInputStream("just some text".toByteArray()), into, wanted) }
        assertTrue(notZip.exceptionOrNull() is BackupFile.NotABackup)
        // a zip, with no note of ours in it
        val other = ByteArrayOutputStream().also { out -> ZipOutputStream(out).use { z -> z.putNextEntry(ZipEntry("till.db")); z.write(ByteArray(10)); z.closeEntry() } }.toByteArray()
        assertEquals("That file is not an EasyPay backup.", runCatching { BackupFile.read(ByteArrayInputStream(other), tmp.newFolder("r2"), wanted) }.exceptionOrNull()?.message)
        // a note that does not say what it is
        val silent = ByteArrayOutputStream().also { out ->
            ZipOutputStream(out).use { z -> z.putNextEntry(ZipEntry(BackupFile.NOTE)); z.write("""{"madeAt":1,"app":"x","database":3}""".toByteArray()); z.closeEntry() }
        }.toByteArray()
        assertEquals("That file is not an EasyPay backup.", runCatching { BackupFile.read(ByteArrayInputStream(silent), tmp.newFolder("r5"), wanted) }.exceptionOrNull()?.message)
        // a note that says it is something else
        val foreign = ByteArrayOutputStream().also { out ->
            ZipOutputStream(out).use { z -> z.putNextEntry(ZipEntry(BackupFile.NOTE)); z.write("""{"kind":"something-else","madeAt":1,"app":"x","database":3}""".toByteArray()); z.closeEntry() }
        }.toByteArray()
        assertEquals("That file is not an EasyPay backup.", runCatching { BackupFile.read(ByteArrayInputStream(foreign), tmp.newFolder("r3"), wanted) }.exceptionOrNull()?.message)
    }

    @Test fun `only the till's own files are taken, each as a plain file in the folder given`() {
        val zip = ByteArrayOutputStream().also { out ->
            ZipOutputStream(out).use { z ->
                z.putNextEntry(ZipEntry(BackupFile.NOTE)); z.write("""{"kind":"easypay-till-backup","madeAt":1,"app":"x","database":18}""".toByteArray()); z.closeEntry()
                z.putNextEntry(ZipEntry("../outside.txt")); z.write("climbed out".toByteArray()); z.closeEntry()
                z.putNextEntry(ZipEntry("sub/till.db")); z.write("in a folder".toByteArray()); z.closeEntry()
                z.putNextEntry(ZipEntry("shared_prefs.xml")); z.write("not ours".toByteArray()); z.closeEntry()
                z.putNextEntry(ZipEntry("till.db")); z.write("the database".toByteArray()); z.closeEntry()
            }
        }.toByteArray()
        val into = tmp.newFolder("r4")
        BackupFile.read(ByteArrayInputStream(zip), into, wanted)
        assertEquals(listOf("till.db"), into.listFiles()!!.map { it.name })
        assertFalse(File(into.parentFile, "outside.txt").exists())
    }

    @Test fun `a backup this build cannot open is said so before anything is changed`() {
        assertNull(BackupFile.refusal(note, databaseNow = 18, hasDatabase = true))
        // an older tablet's backup is brought up to date when it is opened
        assertNull(BackupFile.refusal(note.copy(database = 14), databaseNow = 18, hasDatabase = true))
        assertTrue(BackupFile.refusal(note.copy(database = 19), 18, true)!!.contains("newer EasyPay"))
        assertEquals("That backup holds no till data.", BackupFile.refusal(note, 18, false))
    }

    @Test fun `the file is named for the business and the day`() {
        assertEquals("EasyPay backup Chez Aisha 2026-10-11.easypay", BackupFile.name("Chez Aisha", "2026-10-11"))
        assertEquals("EasyPay backup A B C 2026-10-11.easypay", BackupFile.name("A/B:C", "2026-10-11"))
        assertEquals("EasyPay backup till 2026-10-11.easypay", BackupFile.name("  ", "2026-10-11"))
        assertTrue(BackupFile.name("Chez Aisha", "2026-10-11").endsWith(BackupFile.ENDING))
    }

    @Test fun `a backup the till placed itself says where it is and that it must be copied off the tablet`() {
        // the owner chose the place: where it is, they know
        assertEquals("Backup saved (1 KB). Keep the file somewhere that is not this tablet.", BackupFile.saved(1, null))
        assertEquals("Backup saved (813 KB). Keep the file somewhere that is not this tablet.", BackupFile.saved(832_000, null))
        // a tablet with no screen to choose a place on: the till chose, so it names the place
        val said = BackupFile.saved(832_000, BackupFile.IN_DOWNLOADS)
        assertTrue(said.startsWith("Backup saved in this tablet's Download folder, under EasyPay (813 KB)."))
        assertTrue(said.contains("Copy that file to a USB stick or a Drive"))
        assertTrue(BackupFile.saved(10, BackupFile.inOwnFolder("Android/data/com.restopos.app/files/Backups")).contains("in Android/data/com.restopos.app/files/Backups"))
    }
}
