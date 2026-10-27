package com.restopos.core.database

import androidx.sqlite.db.SupportSQLiteDatabase
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// What an update does to a till's database on its way to this build. A column
// the pull brings that an older build did not keep (a branch's phone, Room 36;
// its address, 35) arrives only if the till asks the server for everything
// again: its cursor is past the rows that had it. So a till coming from 35 or
// 36 starts its pull again from the beginning (bug sweep 2026-10-27, 3).
class MigrationsTest {
    // the statements the migrations from `from` on give the database, in order
    private fun said(from: Int): List<String> {
        val out = ArrayList<String>()
        val db = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(SupportSQLiteDatabase::class.java)) { _, m, args ->
            if (m.name == "execSQL") out.add(args[0] as String) else error("a migration asked the database for ${m.name}")
            null
        } as SupportSQLiteDatabase
        Migrations.ALL.filter { it.startVersion >= from }.forEach { it.migrate(db) }
        return out
    }

    @Test fun the_steps_follow_one_another_with_no_gap() {
        Migrations.ALL.forEachIndexed { i, m ->
            assertEquals(i + 1, m.startVersion)
            assertEquals(i + 2, m.endVersion)
        }
    }

    @Test fun a_till_on_35_or_36_pulls_every_branch_again() {
        for (from in listOf(35, 36)) {
            val run = said(from)
            val reset = run.indexOfLast { it == "UPDATE `sync_state` SET `cursor` = 0" }
            val phone = run.indexOfFirst { it.contains("ADD COLUMN `phone`") }
            assertTrue("from $from: $run", reset >= 0 && reset > phone)
        }
    }
}
