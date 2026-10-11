package com.restopos.core.sync

import com.restopos.core.database.StockLevelEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// A tablet that works on its own, asked to fetch what EasyPay set up for its
// business: what it takes, what it keeps of its own, and what it says.
class FetchedTest {
    private val sent = StockLevelEntity("s", "i", "", qty = 50_000, server_seq = 90, avg_cost = 120.0, reorder_point = 5_000, reorder_qty = 24_000)

    @Test fun `the tablet's own count of its stock stays, and what was set up beside it is taken`() {
        // 50 on the server the day it was set up; 31 sold since, which only the tablet counted
        val own = StockLevelEntity("s", "i", "", qty = 19_000, server_seq = 12, avg_cost = 118.5, reorder_point = null, reorder_qty = null)
        val kept = Fetched.level(own, sent)
        assertEquals(19_000, kept.qty)
        assertEquals(118.5, kept.avg_cost, 0.0)
        assertEquals(listOf<Int?>(5_000, 24_000), listOf(kept.reorder_point, kept.reorder_qty))
        assertEquals(90L, kept.server_seq)
    }

    @Test fun `a level the tablet has none of is taken whole`() {
        assertEquals(sent, Fetched.level(null, sent))
    }

    @Test fun `what came is said in the till's words`() {
        assertEquals("products, taxes and staff", Fetched.said(setOf("items", "item_taxes", "taxes", "employees", "employee_stores"), shop = true))
        assertEquals("the menu and add-ons", Fetched.said(setOf("item_modifier_groups", "modifiers"), shop = false))
        assertEquals("printers", Fetched.said(setOf("printers"), shop = false))
        assertEquals("settings", Fetched.said(setOf("pos_settings", "pos_devices"), shop = true))
    }

    @Test fun `the server's own note of a till that asked is not a change`() {
        assertNull(Fetched.said(emptySet(), shop = true))
        assertNull(Fetched.said(setOf("pos_devices", "stores", "till_requests"), shop = false))
    }

    @Test fun `the answer says what happened, for either key`() {
        fun fetch(done: Boolean, finished: Boolean = done, brought: String? = null, connected: Boolean = false, signIn: Boolean = false) =
            Fetched.answer(fetching = true, connected = connected, signIn = signIn, done = done, finished = finished, brought = brought)
        assertEquals("From EasyPay: products and taxes. It is on this tablet now, and the tablet goes on working on its own.", fetch(done = true, brought = "products and taxes"))
        assertEquals("Nothing new from EasyPay. This tablet has everything that was set up for it.", fetch(done = true))
        assertTrue(fetch(done = false, finished = true).startsWith("EasyPay could not be reached"))
        assertTrue(fetch(done = false, finished = false).startsWith("No answer yet"))
        // made Premium meanwhile: the tablet is connected, whichever key asked
        assertTrue(fetch(done = true, connected = true, brought = "settings").startsWith("This business is on Premium"))
        assertTrue(fetch(done = false, finished = true, signIn = true).contains("Get changes from EasyPay again"))
        // "Connect to the cloud" asked the same question
        fun connect(brought: String?) = Fetched.answer(fetching = false, connected = false, signIn = false, done = true, finished = true, brought = brought)
        assertEquals("This business is not on Premium. Nothing has changed: the tablet goes on working on its own.", connect(null))
        assertEquals("This business is not on Premium: the tablet goes on working on its own. EasyPay had changes for it (staff): they are here now.", connect("staff"))
    }
}
