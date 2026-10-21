package com.restopos.core.display

import com.restopos.core.data.PosSettings
import com.restopos.core.data.Routing
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.kitchen.ScreenClient
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

// How a customer display stands with this till, for Settings, Printers.
data class DisplayStatus(val answering: Boolean, val trouble: String?, val heardAt: Long?)

// The till's side of its customer displays, at work: from the moment the
// till is up, each display facing it (back office or Settings, Printers) is
// sent the whole picture of now (DisplayFeed): at once when something on the
// register changes, every few seconds while a sale or its change is up, now
// and then while idle, so a display switched on late catches up by itself.
// Over the shop's own Wi-Fi, as a kitchen screen is reached; nothing here
// goes through the internet.
@Singleton
class DisplayLink @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val feed: DisplayFeed,
    private val posters: DisplayPictures,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private val _status = MutableStateFlow<Map<String, DisplayStatus>>(emptyMap())
    val status: StateFlow<Map<String, DisplayStatus>> = _status
    // the logo each display said it holds, by the hash both ends compare
    private val holds = ConcurrentHashMap<String, String>()
    // the picture last sent to each display whole
    private val sentPoster = ConcurrentHashMap<String, String>()
    // the pictures each display said it holds, and the displays still owed one
    private val holdsPosters = ConcurrentHashMap<String, Set<String>>()
    private val owed = ConcurrentHashMap.newKeySet<String>()
    // pictures a display was sent and did not keep (one too old to keep pictures): not sent it again
    private val notKept = ConcurrentHashMap<String, Set<String>>()
    // one exchange at a time with each display
    private val turns = ConcurrentHashMap<String, Mutex>()

    // this store's, switched on, facing this till
    suspend fun displays(): List<PrinterEntity> {
        val store = session.storeId() ?: return emptyList()
        return Routing.displays(Routing.usable(db.ops().printers(store), store), session.deviceId())
    }

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch { loop() }
    }

    private suspend fun loop() {
        val changed = Channel<Unit>(Channel.CONFLATED)
        scope.launch { feed.changes.collect { changed.trySend(Unit) } }
        while (scope.isActive) {
            var wait = LOOK_AGAIN
            runCatching {
                val all = displays()
                if (all.isNotEmpty()) {
                    val picture = feed.now()
                    coroutineScope { all.map { d -> async { send(d, picture) } }.awaitAll() }
                    wait = if (picture.state == Picture.IDLE) IDLE_MS else BUSY_MS
                    // a display still owed pictures is sent the next one at once
                    if (owed.isNotEmpty()) wait = GATHER_MS
                }
            }
            // until the next picture is due, or the register changed; a few
            // taps in a row are sent as one
            if (withTimeoutOrNull(wait) { changed.receive() } != null) delay(GATHER_MS)
        }
    }

    // One exchange with one display. Its reply, or null when nothing answered.
    private suspend fun send(d: PrinterEntity, picture: Picture): DisplayReply? = turns.getOrPut(d.id) { Mutex() }.withLock {
        val at = DisplayWire.address(d.address)
        val reply = if (at == null) null else {
            val logo = PosSettings.parse(db.ops().settings()).logo?.takeIf { it.length <= DisplayWire.MAX_LOGO }
            val hash = DisplayWire.hash(logo)
            val device = session.deviceId()
            val till = device?.let { db.catalog().device(it) }
            // its pictures in their order, and the first it does not hold, whole
            val shelf = posters.all(d.id)
            val lacking = shelf.firstOrNull { it.hash !in holdsPosters[d.id].orEmpty() && it.hash !in notKept[d.id].orEmpty() }
            if (lacking == null) sentPoster.remove(d.id) else sentPoster[d.id] = lacking.hash
            // the logo only to a display that holds another one ("" for none); never with a picture in the same request
            val (sendLogo, sendPoster) = DisplayWire.parcel(
                if (holds[d.id] != hash) logo.orEmpty() else null,
                lacking?.let { Poster(it.hash, java.util.Base64.getEncoder().encodeToString(it.jpeg)) },
            )
            if (sendPoster == null) sentPoster.remove(d.id)
            val request = DisplayRequest(
                till = device.orEmpty(), tillName = till?.name ?: "Till", display = d.name,
                picture = picture.copy(message = d.message.orEmpty()),
                logo = sendLogo, logoHash = hash, now = System.currentTimeMillis(),
                posters = shelf.map { it.hash },
                poster = sendPoster,
            )
            val payload = DisplayWire.encode(request, d.pair_code.orEmpty())
            withContext(Dispatchers.IO) { runCatching { ScreenClient.exchange(at.first, at.second, payload) }.getOrNull() }?.let { DisplayWire.decodeReply(it) }
        }
        if (reply?.ok == true) {
            holds[d.id] = reply.logoHash
            holdsPosters[d.id] = reply.posters.toSet()
            sentPoster[d.id]?.takeIf { it !in reply.posters }?.let { h -> notKept[d.id] = notKept[d.id].orEmpty() + h }
            // more to send while it lacks one it has been told of and could keep
            val all = posters.all(d.id).map { it.hash }
            if (all.any { it !in reply.posters && it !in notKept[d.id].orEmpty() }) owed += d.id else owed -= d.id
        } else {
            holds.remove(d.id)
            holdsPosters.remove(d.id)
            notKept.remove(d.id)
            owed -= d.id
        }
        val was = _status.value[d.id]
        val now = DisplayStatus(reply?.ok == true, DisplayWire.trouble(d.name, d.address, reply), if (reply?.ok == true) System.currentTimeMillis() else was?.heardAt)
        _status.value = _status.value + (d.id to now)
        reply
    }

    // Settings, Printers: shows the picture of now on a display at once, and says how it answered.
    suspend fun test(id: String): String {
        val d = displays().firstOrNull { it.id == id } ?: return "That display is switched off, faces another till, or was removed."
        val reply = send(d, feed.now())
        return DisplayWire.trouble(d.name, d.address, reply) ?: "${d.name} answered."
    }

    private companion object {
        // between pictures while a sale or its change is up, and while idle
        const val BUSY_MS = 5_000L
        const val IDLE_MS = 30_000L
        // with no display facing this till, how long before it looks again
        const val LOOK_AGAIN = 15_000L
        const val GATHER_MS = 120L
    }
}
