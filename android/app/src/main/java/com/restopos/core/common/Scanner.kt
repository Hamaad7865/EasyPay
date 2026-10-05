package com.restopos.core.common

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

// A barcode scanner plugged into the tablet (USB or Bluetooth, the kind that
// behaves as a keyboard) types what it reads, very fast, and ends with Enter.
// The activity recognises that burst of keys and hands the code here; the
// order screen listens while it is open and adds the item that carries it.
object Scanner {
    private val read = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val codes: SharedFlow<String> = read

    private val keys = StringBuilder()
    private var last = 0L

    // One key from a real keyboard or scanner. at: when it was pressed, in
    // milliseconds. Returns the code when this key was the Enter that ends a
    // scan, else null. Someone typing is never this fast: more than 80 ms
    // between two keys starts again.
    fun key(char: Int, enter: Boolean, at: Long): String? {
        if (at - last > 80) keys.clear()
        last = at
        if (!enter) {
            if (char in 33..126) keys.append(char.toChar())
            return null
        }
        val code = keys.toString()
        keys.clear()
        return code.takeIf { it.length >= 4 }
    }

    fun scanned(code: String) { read.tryEmit(code) }
}
