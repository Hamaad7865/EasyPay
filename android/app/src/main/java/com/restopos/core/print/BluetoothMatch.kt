package com.restopos.core.print

// Which of the devices paired with this tablet a Bluetooth printer is. The
// back office holds what the printer is looked for by (Printers, Connection:
// Bluetooth): the name the tablet shows for it when it is paired ("MPT-II"),
// or its Bluetooth address (00:11:22:AA:BB:CC). Pairing is the tablet's own
// to do, in its Bluetooth settings; the till only finds the printer among
// what is paired. No Android in it, so its rules are tested without a tablet.
object BluetoothMatch {
    // a device paired with the tablet: `printer` when it says it is one
    class Paired(val name: String?, val address: String, val printer: Boolean = false)

    private val ADDRESS = Regex("^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$")
    fun isAddress(text: String): Boolean = ADDRESS.matches(text.trim())
    private fun plain(address: String) = address.trim().uppercase().replace('-', ':')

    // By its address when an address was typed, else by its name, whatever
    // the capitals. Two paired devices of the same name (two printers of one
    // model): the one that says it is a printer, else the first; an address
    // tells them apart for good. Nothing typed: the only paired printer, when
    // there is exactly one.
    fun pick(wanted: String?, paired: List<Paired>): Paired? {
        val w = wanted?.trim().orEmpty()
        if (w.isEmpty()) return paired.filter { it.printer }.singleOrNull()
        if (isAddress(w)) return paired.firstOrNull { plain(it.address) == plain(w) }
        val named = paired.filter { it.name?.trim().equals(w, ignoreCase = true) }
        return named.firstOrNull { it.printer } ?: named.firstOrNull()
    }
}
