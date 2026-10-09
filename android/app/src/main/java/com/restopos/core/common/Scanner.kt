package com.restopos.core.common

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow

// A barcode scanner plugged into the tablet (USB or Bluetooth, the kind that
// behaves as a keyboard) types what it reads, very fast, and ends with Enter.
// The activity recognises that burst of keys and hands the code here; the
// screen that is open listens and does what the code asks: a restaurant's
// order and a shop's sale add the product, a shop's stock check opens it, and
// a receipt's own code opens the receipt.
//
// Two ways in. Without scan mode, the keys go to the screen as always and a
// burst is told from typing by its speed. With scan mode (the key beside a
// shop's search box), every key is kept from the screen and put together in
// `wedge`: no field holds the focus, so no keyboard comes up.
object Scanner {
    private val read = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val codes: SharedFlow<String> = read

    // Scan mode is on (the tablet's own switch), and a screen that takes scans
    // is the one on show. Both are set from the screen and read by the
    // activity on the same thread.
    var mode = false
    var taking = false
    val capturing: Boolean get() = mode && taking
    val wedge = Wedge()

    // The scanners added on this tablet (Settings, Scanners), each by the name
    // Android itself keeps for the device. A key from one of them is a scan
    // wherever a screen takes scans, with scan mode or without: it is never
    // typed into a box, and its Enter never presses what has the focus. A
    // keyboard that was not added types as always.
    @Volatile var added: Set<String> = emptySet()
    fun takes(device: String?): Boolean = taking && (mode || (device != null && device in added))

    // Settings, Scanners is open: it wants to know which device a scan comes
    // from, to add it or to show that it reads. While it listens, the keys of
    // every real keyboard and scanner are put together here, apart for each
    // device, and reach nothing else.
    @Volatile var listener: ((device: String, code: String) -> Unit)? = null
    private val ears = HashMap<String, Wedge>()
    // one key from `device`; the code when this key was the one that ends a scan
    fun listen(device: String, char: Int, ends: Boolean, at: Long): String? {
        val ear = ears.getOrPut(device) { Wedge() }
        if (ends) return ear.enter()
        ear.key(char, at)
        return null
    }
    fun stopListening() { listener = null; ears.clear() }

    // What the last scan did ("Added · Cotton scarf", "No match · 123"), for
    // the strip that stands where the search box was while scan mode is on.
    class Said(val ok: Boolean, val text: String)
    val said = MutableStateFlow<Said?>(null)
    fun say(ok: Boolean, text: String) { said.value = Said(ok, text) }

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

// A scanner added on this tablet: the name Android keeps for the device (the
// same after the tablet restarts, and when the scanner is unplugged and
// plugged in again), what the scanner calls itself, and how it is joined to
// the tablet ("usb", "bluetooth" or "built in").
@kotlinx.serialization.Serializable
data class AddedScanner(val key: String, val name: String, val link: String) {
    val joined: String get() = when (link) { "usb" -> "USB"; "bluetooth" -> "Bluetooth"; else -> "Built in" }
}

// The list as the tablet keeps it. A list that cannot be read is no list:
// scanners still work, they only have to be added again.
object AddedScanners {
    private val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
    fun read(text: String?): List<AddedScanner> =
        if (text.isNullOrBlank()) emptyList()
        else runCatching { json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(AddedScanner.serializer()), text) }.getOrDefault(emptyList())
    fun write(list: List<AddedScanner>): String = json.encodeToString(kotlinx.serialization.builtins.ListSerializer(AddedScanner.serializer()), list)
    // added once: adding the same device again gives it its new name and link
    fun with(list: List<AddedScanner>, one: AddedScanner): List<AddedScanner> = list.filter { it.key != one.key } + one
    fun without(list: List<AddedScanner>, key: String): List<AddedScanner> = list.filter { it.key != key }
}

// A scanner's keys put together with no text field, after the Kids Corner
// till's: in scan mode nothing is typed anywhere, so there is nothing for a
// keyboard to attach to. No Android in it, so its rules are tested without a
// tablet. gapMs: keys further apart than this are not one scan (a scanner's
// are 5 to 30 ms apart), so a stray key never sticks to the next code. least:
// an Enter after fewer characters is noise, not a code.
class Wedge(private val gapMs: Long = 150, private val least: Int = 3) {
    private val buf = StringBuilder()
    private var last = 0L

    // one character from the scanner; control characters are dropped
    fun key(char: Int, at: Long) {
        if (char < 32 || char == 127) return
        if (buf.isNotEmpty() && at - last > gapMs) buf.clear()
        last = at
        buf.append(char.toChar())
    }

    // The key that ends a scan (Enter, or Tab on some scanners): the code, or null when it was noise.
    fun enter(): String? {
        val code = buf.toString().trim()
        buf.clear()
        return code.takeIf { it.length >= least }
    }

    fun backspace() { if (buf.isNotEmpty()) buf.deleteCharAt(buf.length - 1) }
    fun reset() { buf.clear() }
}
