package com.restopos.core.data

import com.restopos.core.database.PrinterEntity

// A printer as the first-run set-up makes or changes one: its name, how the
// tablet reaches it and its paper. The rules are the back office's
// (printers/page.tsx), which the server holds too (0089, printer.save); reading
// them here catches a slip before the tablet asks, and puts the server's
// refusals in the till's words.
object PrinterForm {
    const val NETWORK = "network"
    const val USB = "usb"
    const val BLUETOOTH = "bluetooth"

    // an IP address, with a port or without: the back office's own pattern
    private val IP = Regex("""^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(:\d{2,5})?$""")

    class Printer(val name: String, val kind: String, val address: String?, val paper: Int)

    // What the form holds, read as a printer, or why it is not one yet.
    fun read(name: String, kind: String, address: String, paper: Int): Result<Printer> = runCatching {
        val called = name.trim().take(40)
        require(called.isNotEmpty()) { "Give the printer a name" }
        val how = if (kind == USB || kind == BLUETOOTH) kind else NETWORK
        val at = address.trim().take(40)
        val where = when (how) {
            USB -> null // the one plugged into the tablet
            BLUETOOTH -> {
                // the name or address the tablet pairs it by, which an IP address is not
                require(at.isNotEmpty() && !IP.matches(at)) { "Pick the printer among the devices paired with this tablet" }
                at
            }
            else -> {
                require(IP.matches(at)) { "Type the printer's IP address, for example 192.168.1.50" }
                at
            }
        }
        Printer(called, how, where, if (paper in PAPERS) paper else 80)
    }

    // A printer's paper: 80 mm, 58 mm, or 57, a 57 mm roll in a printer made
    // for 80 mm rolls (EscPos.IN_WIDE, 0127).
    val PAPERS = setOf(80, 58, com.restopos.core.print.EscPos.IN_WIDE)

    // The paper in words, for a list: "80 mm paper".
    fun paperName(mm: Int): String = if (mm == com.restopos.core.print.EscPos.IN_WIDE) "57 mm roll in an 80 mm printer" else "$mm mm paper"

    // The choices, as the forms' keys say them.
    val PAPER_KEYS = listOf(80 to "80 mm", 58 to "58 mm", com.restopos.core.print.EscPos.IN_WIDE to "57 in 80 mm")

    // A word under the choice: what to pick when 58 mm cuts letters off at the
    // left, and what 57 in 80 mm is for.
    fun paperHint(mm: Int): String? = when (mm) {
        58 -> "Letters cut off at the left? If the printer takes 80 mm rolls, pick 57 in 80 mm."
        com.restopos.core.print.EscPos.IN_WIDE -> "A 57 mm roll in a printer made for 80 mm rolls: the print is kept in the middle of the roll. A printer made for 58 mm rolls stays on 58 mm."
        else -> null
    }

    // The same printer as a row, though it is not stored: the test page is
    // sent to it before anything is saved, so that a wrong address never is.
    fun entity(p: Printer, id: String, tenant: String, store: String): PrinterEntity =
        PrinterEntity(id, tenant, store, p.name, p.kind, p.address, p.paper, is_receipt = true, feed_lines = 3, cut = true)

    // How a printer is reached, in a few words, for a list.
    fun connection(kind: String, address: String?): String {
        val at = address?.trim().orEmpty()
        return when (kind) {
            USB -> "USB"
            BLUETOOTH -> if (at.isEmpty()) "Bluetooth" else "Bluetooth · $at"
            else -> if (at.isEmpty()) "Network" else "Network · $at"
        }
    }

    // What to check when the test page did not come out.
    fun hint(kind: String): String = when (kind) {
        USB -> "Check the cable at both ends, that the printer is switched on, and that the tablet was allowed to use it."
        BLUETOOTH -> "Check that the printer is switched on, near the tablet, and paired with it in the tablet's Bluetooth settings."
        else -> "Check that the printer is switched on, on the same network as the tablet, and that the address is the one on its self-test page."
    }

    // ---- a customer display (0130), added on a tablet that works on its own ----
    const val DISPLAY = "display"

    // Its name, its address on the Wi-Fi and the code it shows, and its two
    // lines for between sales (one line break, at most 120 characters).
    class Display(val name: String, val address: String, val code: String, val message: String?)

    fun readDisplay(name: String, address: String, code: String, first: String, second: String): Result<Display> = runCatching {
        val called = name.trim().take(40)
        require(called.isNotEmpty()) { "Give the display a name, for example Counter" }
        val at = address.trim().take(40)
        require(IP.matches(at)) { "Type the address the display shows, for example 192.168.1.70" }
        val tidy = com.restopos.core.kitchen.PairCode.tidy(code)
        require(tidy != null) { "Type the pairing code the display shows: eight letters and digits" }
        val message = listOf(first, second).map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n").take(120).ifEmpty { null }
        Display(called, at, tidy, message)
    }

    // The server's refusal of a display, in words.
    fun refusedDisplay(code: String?): String = when (code) {
        "bad-address" -> "Check the display's address and its pairing code: they were not taken."
        "bad-device" -> "This till is not known for its store yet. Let it sync, then try again."
        "bad-printer" -> "That display is no longer there. Close this and open it again."
        else -> refused(code)
    }

    // The server's refusal of printer.save (migration 0089), in words.
    fun refused(code: String?): String = when (code) {
        "name-required" -> "Give the printer a name"
        "bad-address" -> "The server did not take that address. Check it and try again."
        "bad-printer" -> "That printer is no longer there. Close this and open it again."
        "bad-store" -> "This till's store is no longer there."
        "conflict" -> "That did not work. Close this and try again."
        "forbidden" -> "You are not allowed to set up printers. Ask a manager."
        "unknown-op" -> "The server has to be updated before a printer can be added from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}
