package com.restopos.core.guest

import com.restopos.app.BuildConfig
import com.restopos.core.common.Chime
import com.restopos.core.data.PosSettings
import com.restopos.core.database.GuestOrderEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.AuthClient
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Toaster
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

// How ordering from the table stands on this till, for whoever looks:
// whether this till listens at all, whether the line is up, the store's
// public id (the address on its table cards), and what is wrong in words.
data class GuestState(val wanted: Boolean = false, val connected: Boolean = false, val store: String? = null, val trouble: String? = null)

// The till's line to the ordering site (cloudflare/relay, order.easypaypos.com),
// where a guest who scanned the code on their table sees the menu and sends an
// order. One socket, kept open while the till listens. Over it the till
// publishes its menu, when the line comes up and whenever a dish, an option,
// a table or a setting changes; is handed each order the moment it is placed
// (and, when it connects, the ones that waited); and gives the cashier's
// answer. It does not ask again and again: nothing is sent while nothing
// happens but the pings that keep the line.
//
// The till listens only when its own settings say the restaurant's plan
// carries table ordering, it is a restaurant, the back office's switch is on
// and a day is open on this till. The site asks EasyPay's till service the
// same, with the key this till syncs with, each time it connects: that wakes
// the database, so a till that was turned away (the switch is off there, or
// the till was deactivated) does not knock again until its settings or its
// key change.
//
// The rules of what is said are GuestWire's and GuestCheck's, and are tested
// there; this class opens the line and reads and writes the till's database.
@Singleton
class GuestLink @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val auth: AuthClient,
    private val kick: GuestKick,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    // pings keep a quiet line from being dropped on the way; they are not messages, and wake nothing at the site
    private val client by lazy { OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build() }
    private val _state = MutableStateFlow(GuestState())
    val state: StateFlow<GuestState> = _state

    private sealed interface End {
        data class Closed(val code: Int) : End
        data class Refused(val why: String) : End
        data object Dropped : End
    }
    private sealed interface Heard {
        data object Open : Heard
        data class Said(val text: String) : Heard
        data class Over(val end: End) : Heard
    }

    // Starts listening, once: from then on for as long as the till runs.
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch { loop() }
    }

    private suspend fun wanted(): Boolean {
        val s = PosSettings.parse(db.ops().settings())
        if (!s.premium || s.retail || !s.tableOrdering) return false
        val device = session.deviceId() ?: return false
        return session.storeId() != null && db.staff().openShift(device) != null
    }

    private suspend fun loop() {
        var failures = 0
        // the key and settings the site turned this till away with: it is not asked again until one of them changes
        var turnedAwayWith: String? = null
        while (currentCoroutineContext().isActive) {
            if (!wanted()) { _state.value = GuestState(); turnedAwayWith = null; delay(IDLE_MS); continue }
            val key = auth.tillKey()
            if (key == null) {
                _state.value = GuestState(wanted = true, trouble = "This till has no key of its own yet. It is given one the next time it syncs.")
                delay(IDLE_MS); continue
            }
            val with = key.hashCode().toString() + "|" + db.ops().settings().hashCode()
            if (with == turnedAwayWith) { delay(IDLE_MS); continue }
            when (val end = runCatching { listen(key) }.getOrElse { End.Dropped }) {
                is End.Refused -> { turnedAwayWith = with; _state.value = GuestState(wanted = true, trouble = end.why) }
                is End.Closed -> { failures = 0; if (end.code != PROVE_AGAIN) delay(2_000) }
                End.Dropped -> {
                    failures++
                    _state.update { it.copy(wanted = true, connected = false, trouble = "The line to the ordering site is down. Guests are told to ask a member of staff until it is back.") }
                    delay(backoff(failures))
                }
            }
        }
    }

    // One connection, from knocking to the line going down. Says how it ended.
    @OptIn(FlowPreview::class)
    private suspend fun listen(key: String): End = coroutineScope {
        val heard = Channel<Heard>(Channel.UNLIMITED)
        val request = Request.Builder().url(SITE.trimEnd('/') + "/api/till").header("Authorization", "Device $key").build()
        val socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { heard.trySend(Heard.Open) }
            override fun onMessage(webSocket: WebSocket, text: String) { heard.trySend(Heard.Said(text)) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null); heard.trySend(Heard.Over(End.Closed(code))) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { heard.trySend(Heard.Over(End.Closed(code))) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                heard.trySend(Heard.Over(when (response?.code) {
                    401 -> End.Refused("The ordering site does not know this till. It is asked again once the till has synced.")
                    403 -> End.Refused("Ordering from the table is switched off for this restaurant, or is not on its plan. It is switched on in the back office, under POS settings.")
                    else -> End.Dropped
                }))
            }
        })
        val work = ArrayList<Job>()
        var published: Int? = null // the menu last sent on this line: one that has not changed is not sent again
        suspend fun publish() {
            val text = menu() ?: return
            if (text.hashCode() == published) return
            if (text.length > MENU_MOST) { _state.update { it.copy(trouble = "The menu is too long for the ordering site.") }; return }
            if (socket.send(text)) published = text.hashCode()
        }
        try {
            for (h in heard) {
                when (h) {
                    Heard.Open -> {
                        _state.update { GuestState(wanted = true, connected = true, store = it.store) }
                        db.guest().stale(System.currentTimeMillis() - STALE_MS)
                        db.guest().forget(System.currentTimeMillis() - KEEP_MS)
                        publish()
                        // the menu again whenever something of it is written, once the writing has settled
                        work += launch { db.guest().pulse().debounce(1_500).collect { publish() } }
                        // the cashier's answers: what the site has not been told, now and each time one is given
                        work += launch { while (true) { for (r in db.guest().untold()) socket.send(GuestWire.answer(r.id, r.status == "accepted", r.reason)); kick.await() } }
                        // a till that should no longer listen (the switch, the plan, the day closed) hangs up
                        work += launch { while (true) { delay(WATCH_MS); if (!wanted()) { socket.close(1000, "off"); break } } }
                    }
                    is Heard.Said -> said(GuestWire.read(h.text))
                    is Heard.Over -> return@coroutineScope h.end
                }
            }
            End.Dropped
        } finally {
            work.forEach { it.cancel() }
            socket.cancel()
            _state.update { it.copy(connected = false) }
        }
    }

    private suspend fun said(m: FromRelay) {
        when (m) {
            is FromRelay.Hello -> _state.update { it.copy(store = m.store) }
            is FromRelay.Order -> {
                val o = m.order
                val fresh = db.guest().add(GuestOrderEntity(o.id, o.table, GuestWire.write(o.lines), placed_at = o.at, received_at = System.currentTimeMillis())) != -1L
                if (fresh) {
                    val table = session.storeId()?.let { db.tables().tablesNow(it) }.orEmpty().firstOrNull { it.id == o.table }?.name
                    Chime.order()
                    Toaster.say((table?.let { com.restopos.core.common.tableLabel(it) } ?: "A table") + " placed an order. Tap the phone key at the top to see it.")
                } else kick.now() // one this till has answered and the site never heard: it is told again
            }
            is FromRelay.Answered -> db.guest().told(m.id)
            is FromRelay.Unknown -> { db.guest().gone(m.id); db.guest().told(m.id) }
            is FromRelay.Gone -> db.guest().gone(m.id)
            is FromRelay.MenuRefused -> _state.update { it.copy(trouble = "The ordering site did not take the menu: ${m.why}.") }
            FromRelay.MenuTaken -> _state.update { it.copy(trouble = null) }
            FromRelay.Nothing -> Unit
        }
    }

    // The till's menu as it is now, as the message that publishes it.
    private suspend fun menu(): String? {
        val store = session.storeId() ?: return null
        val s = PosSettings.parse(db.ops().settings())
        val g = db.guest()
        return GuestWire.menu(GuestMenu.snapshot(GuestMenu.Source(
            name = s.companyName.ifBlank { session.businessName().orEmpty() },
            decimals = s.decimals,
            note = "Prices in Mauritian rupees." + if (s.servicePct > 0) " A service charge of ${s.servicePct}% is added to the bill." else "",
            accepting = true,
            tables = db.tables().tablesNow(store),
            categories = g.categories(), items = g.items(), groups = g.groups(), options = g.options(),
            links = g.links().map { it.item_id to it.group_id },
        )))
    }

    companion object {
        // where guests order: the release's is the address on the table cards; a debug build is given one of its own (relayUrl)
        val SITE: String = BuildConfig.RELAY_URL.ifBlank { "https://order.easypaypos.com" }
        const val PROVE_AGAIN = 4001 // the site's "come back and say again whose till you are"
        const val IDLE_MS = 15_000L
        const val WATCH_MS = 20_000L
        const val MENU_MOST = 500_000
        const val STALE_MS = 2 * 60 * 60 * 1000L // as the site drops an order nobody answered
        const val KEEP_MS = 24 * 60 * 60 * 1000L
        // a line that went down is tried again after 5 seconds, then 10, 20, 40, and every minute from there
        fun backoff(failures: Int): Long = (5_000L shl (failures - 1).coerceIn(0, 4)).coerceAtMost(60_000L)
    }
}
