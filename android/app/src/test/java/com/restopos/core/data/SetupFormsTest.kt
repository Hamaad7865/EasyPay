package com.restopos.core.data

import com.restopos.core.database.EmployeeEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The three forms of the first-run set-up that are not the menu's: the
// printer, a member of staff and the business's details. The server checks
// the same things and has the last word (0089); reading them here catches a
// slip before the tablet asks, and puts the server's refusals in the till's
// words.
class SetupFormsTest {
    // ---- the printer ----
    private fun printer(kind: String, address: String, name: String = "Receipt", paper: Int = 80) = PrinterForm.read(name, kind, address, paper)
    private fun whyNot(kind: String, address: String, name: String = "Receipt") = printer(kind, address, name).exceptionOrNull()?.message

    @Test fun `a printer has a name, cut at forty`() {
        assertEquals("Give the printer a name", whyNot("usb", "", name = "   "))
        assertEquals("Receipt", printer("usb", "", name = "  Receipt ").getOrThrow().name)
        assertEquals(40, printer("usb", "", name = "x".repeat(60)).getOrThrow().name.length)
    }

    @Test fun `a network printer is reached at an IP address, with a port or without`() {
        assertEquals("192.168.1.50", printer("network", " 192.168.1.50 ").getOrThrow().address)
        assertEquals("192.168.1.50:9100", printer("network", "192.168.1.50:9100").getOrThrow().address)
        listOf("", "printer.local", "999.1.1.1", "192.168.1", "192.168.1.50:1").forEach {
            assertEquals(it, "Type the printer's IP address, for example 192.168.1.50", whyNot("network", it))
        }
    }

    @Test fun `a Bluetooth printer is one of the tablet's paired devices, by name or by address`() {
        assertEquals("MPT-II", printer("bluetooth", " MPT-II ").getOrThrow().address)
        assertEquals("00:11:22:AA:BB:CC", printer("bluetooth", "00:11:22:AA:BB:CC").getOrThrow().address)
        assertEquals("Pick the printer among the devices paired with this tablet", whyNot("bluetooth", ""))
        // an IP address is how a network printer is found, never a paired one
        assertEquals("Pick the printer among the devices paired with this tablet", whyNot("bluetooth", "192.168.1.9"))
    }

    @Test fun `a USB printer has no address, and paper is 58 or 80`() {
        assertNull(printer("usb", "whatever was typed").getOrThrow().address)
        assertEquals(58, printer("usb", "", paper = 58).getOrThrow().paper)
        assertEquals(80, printer("usb", "", paper = 72).getOrThrow().paper)
        // a kind the till does not know is a network printer, as the back office reads it
        assertEquals("network", printer("carrier pigeon", "10.0.0.2").getOrThrow().kind)
    }

    @Test fun `the test page goes to a printer that is not stored yet`() {
        val p = printer("bluetooth", "MPT-II", paper = 58).getOrThrow()
        val e = PrinterForm.entity(p, "id-1", "tenant-1", "store-1")
        assertEquals(listOf("id-1", "tenant-1", "store-1", "Receipt", "bluetooth", "MPT-II"), listOf(e.id, e.tenant_id, e.store_id, e.name, e.kind, e.address))
        assertEquals(58, e.paper_mm)
        assertTrue(e.is_receipt && e.cut && e.is_active && e.feed_lines == 3)
    }

    @Test fun `how a printer is reached is said in a few words`() {
        assertEquals("Network · 192.168.1.50", PrinterForm.connection("network", "192.168.1.50"))
        assertEquals("USB", PrinterForm.connection("usb", null))
        assertEquals("Bluetooth · MPT-II", PrinterForm.connection("bluetooth", "MPT-II"))
        assertEquals("Bluetooth", PrinterForm.connection("bluetooth", " "))
    }

    @Test fun `a test page that did not print says what to check for that connection`() {
        val hints = listOf("network", "usb", "bluetooth").map { PrinterForm.hint(it) }
        assertEquals(3, hints.toSet().size)
        assertTrue(hints[0].contains("same network"))
        assertTrue(hints[1].contains("cable"))
        assertTrue(hints[2].contains("paired"))
    }

    @Test fun `the server's refusal of a printer is put in words`() {
        assertEquals("The server did not take that address. Check it and try again.", PrinterForm.refused("bad-address"))
        assertEquals("That printer is no longer there. Close this and open it again.", PrinterForm.refused("bad-printer"))
        assertEquals("This till's store is no longer there.", PrinterForm.refused("bad-store"))
        assertEquals("You are not allowed to set up printers. Ask a manager.", PrinterForm.refused("forbidden"))
        assertEquals("The server has to be updated before a printer can be added from a till.", PrinterForm.refused("unknown-op"))
        assertEquals("Give the printer a name", PrinterForm.refused("name-required"))
        assertEquals("The server refused it.", PrinterForm.refused(null))
        assertEquals("The server refused it (odd-code).", PrinterForm.refused("odd-code"))
    }

    // ---- staff ----
    private fun member(name: String, pin: Boolean, vararg perms: String) =
        StaffMember(EmployeeEntity(name, "t", name, if (pin) "hash" else null, "r"), name, perms.toSet(), null)

    @Test fun `a member of staff has a name and a PIN of four digits`() {
        assertEquals("Asha" to "0420", StaffForm.read("  Asha ", "0420").getOrThrow())
        assertEquals("Give them a name", StaffForm.read("  ", "0420").exceptionOrNull()?.message)
        assertEquals("A PIN is 4 digits", StaffForm.read("Asha", "042").exceptionOrNull()?.message)
        assertEquals("A PIN is 4 digits", StaffForm.read("Asha", "04a0").exceptionOrNull()?.message)
        assertEquals(80, StaffForm.read("x".repeat(100), "0420").getOrThrow().first.length)
    }

    // Once anyone has a PIN the till asks for one: to clock in, to open the
    // day, to approve. So the first PIN goes to someone who may open the day
    // and set up the till. A cashier may open the day and approve nothing.
    @Test fun `the first PIN goes to the owner or a manager`() {
        val owner = member("Owner", false, "*")
        val manager = member("Manager", false, "shift.open_close", "settings.device", "sale.create")
        val cashier = member("Cashier", false, "shift.open_close", "sale.create")
        val waiter = member("Waiter", false, "sale.create")
        val all = listOf(owner, manager, cashier, waiter)
        assertTrue(StaffForm.mayHavePin(owner, all))
        assertTrue(StaffForm.mayHavePin(manager, all))
        assertFalse(StaffForm.mayHavePin(cashier, all))
        assertFalse(StaffForm.mayHavePin(waiter, all))
        assertFalse(StaffForm.mayAdd(all))
    }

    @Test fun `and once one of them has it, everyone may have one`() {
        val owner = member("Owner", true, "*")
        val cashier = member("Cashier", false, "shift.open_close", "sale.create")
        val waiter = member("Waiter", false, "sale.create")
        val all = listOf(owner, cashier, waiter)
        assertTrue(StaffForm.mayHavePin(cashier, all))
        assertTrue(StaffForm.mayHavePin(waiter, all))
        assertTrue(StaffForm.mayAdd(all))
        // a cashier's PIN alone opens nothing for the others
        val only = listOf(member("Owner", false, "*"), member("Cashier", true, "shift.open_close"), waiter)
        assertFalse(StaffForm.mayHavePin(waiter, only))
        assertFalse(StaffForm.mayAdd(only))
    }

    @Test fun `the server's refusal of a member of staff or a PIN is put in words`() {
        assertEquals("Only the owner can add staff or set a PIN. Ask the owner, or do it in the back office, under Staff.", StaffForm.refused("forbidden"))
        assertEquals("That role is no longer there. Pick another.", StaffForm.refused("bad-role"))
        assertEquals("That PIN could not be saved. Type it again.", StaffForm.refused("bad-pin"))
        assertEquals("That person is no longer there.", StaffForm.refused("unknown-staff"))
        assertEquals("The server has to be updated before staff can be added from a till.", StaffForm.refused("unknown-op"))
        assertEquals("Give them a name", StaffForm.refused("name-required"))
        assertNotEquals(StaffForm.refused(null), StaffForm.refused("odd-code"))
    }

    // ---- the business's details ----
    @Test fun `the business's details are read, each cut at its length`() {
        val c = CompanyForm.read("  Chez Nous ", " Royal Road\nCurepipe ", " 5 123 4567 ", " C12345678 ", " VAT27000000 ").getOrThrow()
        assertEquals(listOf("Chez Nous", "Royal Road\nCurepipe", "5 123 4567", "C12345678", "VAT27000000"), listOf(c.name, c.address, c.phone, c.brn, c.vat))
        assertEquals("The business needs a name", CompanyForm.read(" ", "", "", "", "").exceptionOrNull()?.message)
        val long = CompanyForm.read("n".repeat(100), "a".repeat(300), "p".repeat(60), "b".repeat(40), "v".repeat(40)).getOrThrow()
        assertEquals(listOf(80, 240, 40, 30, 30), listOf(long.name.length, long.address.length, long.phone.length, long.brn.length, long.vat.length))
    }

    @Test fun `the top of the receipt is what the printer will print`() {
        val full = CompanyForm.read("Chez Nous", "Royal Road\n\n Curepipe ", "5 123 4567", "C12345678", "VAT27000000").getOrThrow()
        assertEquals(listOf("Chez Nous", "Royal Road", "Curepipe", "Tel: 5 123 4567", "BRN: C12345678", "VAT: VAT27000000"), CompanyForm.top(full))
        val bare = CompanyForm.read("Chez Nous", "", "", "", "").getOrThrow()
        assertEquals(listOf("Chez Nous"), CompanyForm.top(bare))
    }

    @Test fun `the same details are the same, whatever the spaces`() {
        val a = CompanyForm.read("Chez Nous", "Royal Road", "5 123 4567", "", "").getOrThrow()
        assertTrue(CompanyForm.same(a, CompanyForm.read(" Chez Nous ", "Royal Road ", "5 123 4567", " ", "").getOrThrow()))
        assertFalse(CompanyForm.same(a, CompanyForm.read("Chez Nous", "Royal Road", "5 123 4568", "", "").getOrThrow()))
    }

    @Test fun `the server's refusal of the details is put in words`() {
        assertEquals("You are not allowed to change the business's details. Ask a manager.", CompanyForm.refused("forbidden"))
        assertEquals("The server has to be updated before these can be changed from a till.", CompanyForm.refused("unknown-op"))
        assertEquals("The business needs a name", CompanyForm.refused("name-required"))
        assertEquals("The server refused it.", CompanyForm.refused(null))
    }
}
