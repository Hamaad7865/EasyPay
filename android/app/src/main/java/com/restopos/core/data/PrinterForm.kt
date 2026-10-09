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
        Printer(called, how, where, if (paper == 58) 58 else 80)
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
