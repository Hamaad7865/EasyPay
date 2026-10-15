package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// "See the day's payments" became a tick of its own (server 0111). A tablet
// that works on its own gives it to the roles it holds by the server's rule.
class PermsTest {
    @Test fun `a role that sees the day's figures is given the day's payments, and no other`() {
        assertEquals("""["sale.create","shift.view_report","payments.view"]""", Perms.grantPayments("""["sale.create","shift.view_report"]"""))
        assertNull(Perms.grantPayments("""["sale.create","receipts.view_all"]"""))
        assertNull(Perms.grantPayments("""["*"]"""))
        assertNull(Perms.grantPayments("""["shift.view_report","payments.view"]"""))
        assertNull(Perms.grantPayments("not a list"))
    }

    @Test fun `both kinds of business offer it beside all receipts`() {
        for (shop in listOf(false, true)) {
            val receipts = Perms.groups(shop).first { it.title == "Receipts" }.perms.map { it.first }
            assertEquals(listOf("receipts.view_all", "payments.view", "receipts.reprint"), receipts)
        }
        assertTrue(Perms.offered(false).contains("payments.view"))
    }
}
