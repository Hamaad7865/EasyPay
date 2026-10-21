package com.restopos.core.display

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

// What a tablet set up as a customer display does with what a till sends it.
// Plain Kotlin, tested on its own; the tablet's screen (feature/display) only
// listens (ScreenServer) and draws what `shown` says.
//
// A till sends the whole picture each time, so the display keeps only the
// latest one and when it came. With two tills sending to one display (two
// displays given the same address by mistake), the latest picture is shown.
// A till that falls silent (switched off mid-sale) must not leave its order
// in front of the next customer: after a minute with no word the display
// shows the idle screen.
class DisplayBook(
    private val code: suspend () -> String,
    private val build: Int,
    private val clock: () -> Long = System::currentTimeMillis,
    // the logo as it is now (null for none) and its hash, kept by the tablet so that it is there after a restart
    private val keepLogo: suspend (String?, String) -> Unit = { _, _ -> },
    // where the pictures shown in turn are kept, by hash (files on the tablet)
    private val shelf: PosterShelf = MemoryPosters(),
) {
    // Where a display keeps the pictures it shows in turn.
    interface PosterShelf {
        suspend fun have(): Set<String>
        suspend fun put(hash: String, jpeg: ByteArray)
        // takes away every one not named
        suspend fun keepOnly(hashes: Set<String>)
    }

    class MemoryPosters : PosterShelf {
        val held = LinkedHashMap<String, ByteArray>()
        override suspend fun have() = held.keys.toSet()
        override suspend fun put(hash: String, jpeg: ByteArray) { held[hash] = jpeg }
        override suspend fun keepOnly(hashes: Set<String>) { held.keys.retainAll(hashes) }
    }

    // the pictures to show in turn, by hash, in the till's order: those it holds
    private val _posters = MutableStateFlow<List<String>>(emptyList())
    val posters: StateFlow<List<String>> = _posters

    data class Held(val picture: Picture, val at: Long, val till: String, val tillName: String)

    private val _held = MutableStateFlow<Held?>(null)
    val held: StateFlow<Held?> = _held
    private val _logo = MutableStateFlow<String?>(null)
    val logo: StateFlow<String?> = _logo
    @Volatile private var logoHash = ""
    private val lock = Mutex()

    // The logo the tablet kept, put back when it starts.
    fun restore(logo: String?) {
        _logo.value = logo?.ifEmpty { null }
        logoHash = DisplayWire.hash(_logo.value)
    }

    // One till's request (its two lines), and the reply to write back.
    suspend fun answer(first: String, second: String): String = lock.withLock {
        val req = DisplayWire.decode(first, second, code())
            ?: return DisplayWire.encode(DisplayReply(false, DisplayWire.REFUSED, build = build))
        if (req.v != DisplayWire.VERSION) return DisplayWire.encode(DisplayReply(false, DisplayWire.OTHER_VERSION, build = build))
        // sent only when this display said it held another one; "" is a business with none
        req.logo?.let { sent ->
            val logo = sent.ifEmpty { null }
            val hash = DisplayWire.hash(logo)
            if (hash != logoHash) {
                _logo.value = logo
                logoHash = hash
                keepLogo(logo, hash)
            }
        }
        // a picture it lacked, whole: kept only when it is what its hash says
        req.poster?.let { p ->
            val jpeg = runCatching { java.util.Base64.getDecoder().decode(p.jpeg) }.getOrNull()
            if (jpeg != null && p.hash in req.posters && DisplayWire.hash(jpeg) == p.hash) shelf.put(p.hash, jpeg)
        }
        shelf.keepOnly(req.posters.toSet())
        val have = shelf.have()
        _posters.value = req.posters.filter { it in have }
        _held.value = Held(req.picture, clock(), req.till, req.tillName)
        DisplayWire.encode(DisplayReply(true, build = build, logoHash = logoHash, posters = _posters.value))
    }

    // What the screen shows now: the latest picture, or the idle screen of the
    // business it came from once its till has said nothing for a minute. Null
    // until a till has spoken to it: the page that says how to pair it.
    fun shown(now: Long = clock()): Picture? {
        val h = _held.value ?: return null
        return if (now - h.at >= SILENT_MS) Pictures.idleOf(h.picture) else h.picture
    }

    // The pictures it kept, put back when it starts (in no order yet: the till's next word gives it).
    suspend fun restorePosters() { _posters.value = shelf.have().toList() }

    // The tablet stops being a display, or its code changes: nothing it was sent is kept.
    suspend fun forget() {
        _held.value = null
        _logo.value = null
        logoHash = ""
        shelf.keepOnly(emptySet())
        _posters.value = emptyList()
    }

    companion object {
        const val SILENT_MS = 60_000L
    }
}
