package com.restopos.core.data

// EasyPay's own barcodes, made as the server makes them (ean13 and
// assign_barcodes, migration 0070): twelve digits, the prefix and then the
// serial filled out with zeros, and their check digit. Every business starts
// with the prefix 200: codes that begin 20 to 29 never leave the shop.
object Barcodes {
    const val PREFIX = "200"

    // null for a serial that has outgrown the room the prefix leaves it: it is
    // never cut short into a number already printed
    fun ean13(prefix: String, serial: Long): String? {
        val width = 12 - prefix.length
        val digits = serial.toString()
        if (serial < 0 || prefix.isEmpty() || !prefix.all { it in '0'..'9' } || width < 1 || digits.length > width) return null
        val payload = prefix + digits.padStart(width, '0')
        // weights 1,3,1,3... from the left, and the digit that takes the sum to the next ten
        val sum = payload.withIndex().sumOf { (i, c) -> (c - '0') * (if (i % 2 == 0) 1 else 3) }
        return payload + ((10 - sum % 10) % 10)
    }

    // A tablet that works on its own makes its codes in a block of its own:
    // T1 from serial 100000001, T2 from 200000001, up to T9 (T10 shares T1's,
    // and so on). The server counts from 1 and two tablets never meet, so a
    // code made on a tablet is not one the back office, or another tablet,
    // gave meanwhile: at "Connect to the cloud" the server would refuse the
    // product as barcode-taken, and every sale of it after. 0: the till is not
    // known, and the codes go on after the highest held, as before.
    const val BLOCK = 100_000_000L
    fun block(till: String?): Int =
        till?.trim()?.removePrefix("T")?.toIntOrNull()?.takeIf { it >= 1 }?.let { (it - 1) % 9 + 1 } ?: 0

    // The serial of one of EasyPay's own; null for any other code.
    fun serial(code: String?, prefix: String = PREFIX): Long? {
        if (code == null || code.length != 13 || !code.all { it in '0'..'9' } || !code.startsWith(prefix)) return null
        val n = code.substring(prefix.length, 12).toLong()
        return n.takeIf { ean13(prefix, it) == code }
    }
}
