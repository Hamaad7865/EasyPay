package com.restopos.feature.kds

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.app.BuildConfig
import com.restopos.core.common.AppUpdate
import com.restopos.core.common.TillRelease
import com.restopos.core.kitchen.KitchenPrefs
import com.restopos.core.kitchen.KitchenPrefsStore
import com.restopos.core.kitchen.PairCode
import com.restopos.core.kitchen.RoomScreenShelf
import com.restopos.core.kitchen.ScreenBook
import com.restopos.core.kitchen.ScreenServer
import com.restopos.core.kitchen.ScreenTicket
import com.restopos.core.kitchen.Wire
import com.restopos.core.network.ApiClient
import com.restopos.core.sync.AppUpdater
import com.restopos.core.sync.Download
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.ToastHost
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.Wordmark
import com.restopos.feature.start.network
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// A tablet set up as a kitchen screen: no login, no menu, no cash, no sales.
// It listens on the restaurant's Wi-Fi for the tills (ScreenServer), keeps
// what they send it (kitchen.db) and shows it on the same board as a till's
// own Kitchen screen. What the cooks tap is written down, and a till takes it
// the next time it asks. It sends our server nothing, and asks it one thing:
// whether a newer EasyPay exists.

// The tickets a kitchen tablet holds, as cards of the board, the one that has
// waited longest first. A ticket's age is counted from when this tablet got
// it. With more than one till sending to the screen, a ticket's number says
// which till's it is: their K numbers count separately.
internal fun kitchenCards(held: List<ScreenTicket>): List<KdsCard> {
    val open = ScreenBook.shown(held)
    val several = open.map { it.till }.distinct().size > 1
    return open.map { t ->
        KdsCard(
            t.id, if (several && t.tillCode.isNotBlank()) "${t.tillCode} #${t.no}" else "#${t.no}", t.label, t.kind, t.covers, t.waiter, t.remark,
            since = t.receivedAt, lines = t.lines.map { KdsLine(it.id, it.qty, it.name, it.detail, it.done, it.voided) },
        )
    }
}

// A newer EasyPay for this tablet: none, offered, being fetched, or here.
sealed interface KitchenUpdate {
    data object None : KitchenUpdate
    data class Offered(val release: TillRelease) : KitchenUpdate
    data class Fetching(val release: TillRelease) : KitchenUpdate
    data class Ready(val release: TillRelease, val apk: android.net.Uri) : KitchenUpdate
}

@HiltViewModel
class KitchenModeViewModel @Inject constructor(
    private val shelf: RoomScreenShelf,
    private val session: SessionStore,
    private val prefsStore: KitchenPrefsStore,
    private val api: ApiClient,
    private val updater: AppUpdater,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    private val book = ScreenBook(shelf, code = { session.pairCode() }, build = BuildConfig.VERSION_CODE)
    private val server = ScreenServer(Wire.PORT) { first, second -> book.answer(first, second) }

    // why the tablet cannot listen, when it cannot (another app holds the port)
    val problem = MutableStateFlow<String?>(null)
    // "Wi-Fi, 192.168.1.60", as the start screen of a till says it
    val address = MutableStateFlow(network(context))
    val code: StateFlow<String> = session.pairCode.map { it.orEmpty() }.stateIn(viewModelScope, SharingStarted.Eagerly, "")
    val prefs: StateFlow<KitchenPrefs> = prefsStore.prefs.stateIn(viewModelScope, SharingStarted.Eagerly, KitchenPrefs())
    val light: StateFlow<Boolean> = session.lightMode.stateIn(viewModelScope, SharingStarted.Eagerly, false)
    val update = MutableStateFlow<KitchenUpdate>(KitchenUpdate.None)
    private val tick = MutableStateFlow(System.currentTimeMillis())

    // Until a till has spoken to it the tablet shows how to pair it; `ready`
    // is false for the moment it takes to read what it holds.
    data class State(val ready: Boolean = false, val paired: Boolean = false, val ui: KdsUi = KdsUi())

    val state: StateFlow<State> = combine(shelf.watch(), book.heard, tick) { held, heard, now ->
        val recall = held.any { it.bumpedAt != null && it.bumpedAt > now - ScreenBook.RECALL_MS }
        // what the tills call this screen: its name in the back office
        val name = heard?.screen?.takeIf { it.isNotBlank() } ?: held.maxByOrNull { it.receivedAt }?.screen?.takeIf { it.isNotBlank() }
        State(
            ready = true, paired = heard != null || held.isNotEmpty(),
            ui = KdsUi(kitchenCards(held), emptyList(), recall, loaded = true, title = name ?: "Kitchen screen", heard = heard?.text(now)),
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, State())

    init {
        listen()
        viewModelScope.launch { book.prune() }
        // the clock the header and "recall" go by, and the address, which a router may change
        viewModelScope.launch {
            while (true) {
                delay(5000)
                tick.value = System.currentTimeMillis()
                address.value = network(context)
                if (!server.listening) listen()
            }
        }
        viewModelScope.launch { look() }
    }

    private fun listen() {
        problem.value = runCatching { server.start(viewModelScope) }.exceptionOrNull()?.let {
            "This tablet cannot listen for the tills: port ${Wire.PORT} is in use. Close EasyPay, open it again, and if this stays, restart the tablet."
        }
    }

    override fun onCleared() { server.stop() }

    fun tap(lineId: String) = viewModelScope.launch { book.tap(lineId) }
    fun bump(ticketId: String) = viewModelScope.launch { book.bump(ticketId)?.let { Toaster.say("$it bumped · ready at the pass") } }
    fun recall() = viewModelScope.launch { book.recallLast()?.let { Toaster.say("$it is back on the screen") } }
    fun save(p: KitchenPrefs) = viewModelScope.launch { prefsStore.save(p) }
    fun setLight(on: Boolean) = viewModelScope.launch { session.setLightMode(on) }

    // A new code: the tills are refused until the back office has been given it.
    fun newCode() = viewModelScope.launch {
        session.setPairCode(PairCode.make())
        Toaster.say("New pairing code. Type it in the back office, under Printers: until then the tills cannot send here.")
    }

    // The tablet stops being a kitchen screen: nothing it was sent is kept.
    fun becomeTill(then: () -> Unit) = viewModelScope.launch {
        server.stop()
        shelf.wipe()
        session.leaveKitchen()
        then()
    }

    // ---- a newer EasyPay: asked of GET /health, which needs no login ----
    private suspend fun look() {
        runCatching { AppUpdate.newer(BuildConfig.VERSION_CODE, api.latestTill()) }.getOrNull()?.let { r ->
            if (update.value is KitchenUpdate.None) update.value = KitchenUpdate.Offered(r)
        }
    }

    fun fetchUpdate() {
        val r = (update.value as? KitchenUpdate.Offered)?.release ?: return
        updater.start(r.version, r.url)
        update.value = KitchenUpdate.Fetching(r)
        viewModelScope.launch {
            while (true) {
                delay(1000)
                when (val d = updater.poll()) {
                    is Download.Ready -> { update.value = KitchenUpdate.Ready(r, d.apk); return@launch }
                    Download.Failed, Download.None -> {
                        update.value = KitchenUpdate.Offered(r)
                        Toaster.say("The update could not be downloaded. Check the connection and try again.")
                        return@launch
                    }
                    Download.Running -> Unit
                }
            }
        }
    }

    fun installUpdate() {
        val ready = update.value as? KitchenUpdate.Ready ?: return
        runCatching {
            if (updater.canInstall()) context.startActivity(updater.installIntent(ready.apk))
            else {
                context.startActivity(updater.allowIntent())
                Toaster.say("Allow EasyPay to install updates, come back, and tap Install again.")
            }
        }.onFailure { Toaster.say("This tablet would not open its installer: ${it.message}") }
    }
}

@Composable
fun KitchenModeScreen(vm: KitchenModeViewModel = hiltViewModel(), onBecomeTill: () -> Unit) {
    val state by vm.state.collectAsState()
    val prefs by vm.prefs.collectAsState()
    val address by vm.address.collectAsState()
    val code by vm.code.collectAsState()
    val problem by vm.problem.collectAsState()
    val update by vm.update.collectAsState()
    val light by vm.light.collectAsState()
    var settings by remember { mutableStateOf(false) }
    // what is being asked before it is done: "code" or "till"
    var asking by remember { mutableStateOf<String?>(null) }
    // A kitchen screen is the tablet's one purpose: Back does not leave it.
    BackHandler {}

    Box(Modifier.fillMaxSize().background(V.Bg).systemBarsPadding()) {
        if (!state.ready) Unit
        else if (!state.paired) Waiting(address, code, problem) { settings = true }
        else Column(Modifier.fillMaxSize()) {
            problem?.let { T(it, 14.sp, 600, V.RedText, Modifier.fillMaxWidth().background(V.RedWash).padding(horizontal = 24.dp, vertical = 10.dp), lines = 3) }
            KdsBoard(state.ui, prefs, onTap = { vm.tap(it) }, onBump = { vm.bump(it) }, onRecall = { vm.recall() }, onSettings = { settings = true }, modifier = Modifier.weight(1f))
        }
        ToastHost()
    }

    if (settings) KitchenPrefsSheet("Kitchen screen", prefs, onChange = { vm.save(it) }, onClose = { settings = false }) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Switch("Sound when an order arrives", "A short sound for each new ticket.", prefs.sound) { vm.save(prefs.copy(sound = !prefs.sound)) }
            Switch("Light screen", "Dark is easier on the eyes in a dim kitchen; light is easier in daylight.", light) { vm.setLight(!light) }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Caps("This tablet", V.Text2)
            PrefRow("Address", "The tills find the screen at this address. Keep it the same on the router, as for a printer.") { T(addressOf(address) ?: "Not on Wi-Fi", 16.sp, 700, lines = 2) }
            PrefRow("Pairing code", "Typed in the back office, under Printers, with the address.") { T(spaced(code), 18.sp, 800, spacing = 2.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Make a new code", Modifier.weight(1f), height = 48.dp) { asking = "code" }
                VBtn("Use as a till instead", Modifier.weight(1f), height = 48.dp) { asking = "till" }
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Caps("EasyPay ${BuildConfig.VERSION_NAME}", V.Text2)
            when (val u = update) {
                KitchenUpdate.None -> T("This tablet has the newest EasyPay it has been told of.", 13.sp, 500, V.Text2, lines = 2)
                is KitchenUpdate.Offered -> PrefRow("EasyPay ${u.release.name} is ready to download", "The tills and this screen should be on the same version.") {
                    VBtn("Download", height = 46.dp, bg = V.Blue, fg = androidx.compose.ui.graphics.Color.White) { vm.fetchUpdate() }
                }
                is KitchenUpdate.Fetching -> T("Downloading EasyPay ${u.release.name}. The screen goes on working.", 13.sp, 500, V.Text2, lines = 2)
                is KitchenUpdate.Ready -> PrefRow("EasyPay ${u.release.name} is here", "Installing takes a moment; the tickets on the screen are kept.") {
                    VBtn("Install", height = 46.dp, bg = V.Blue, fg = androidx.compose.ui.graphics.Color.White) { vm.installUpdate() }
                }
            }
        }
    }

    when (asking) {
        "code" -> Confirm(
            "Make a new pairing code?", "The tills will be refused by this screen until the new code has been typed in the back office, under Printers, and they have synced.",
            "Make a new code", onNo = { asking = null },
        ) { asking = null; vm.newCode() }
        "till" -> Confirm(
            "Use this tablet as a till instead?", "It stops being a kitchen screen: the tickets it holds are cleared, and it opens on the sign-in screen. Orders sent to this screen will wait on the tills.",
            "Yes, make it a till", onNo = { asking = null },
        ) { asking = null; settings = false; vm.becomeTill(onBecomeTill) }
    }
}

// "ABCD 2345": a code read off one screen and typed on another, in two halves
private fun spaced(code: String): String = if (code.length == 8) code.substring(0, 4) + " " + code.substring(4) else code

// The address to type, alone: "Wi-Fi, 192.168.1.60" is what a till's start
// screen says, and someone would type all of it. Null when the tablet is on
// no network.
internal fun addressOf(network: String): String? = network.substringAfter(", ", "").trim().takeIf { it.isNotEmpty() }

// Before any till has spoken to it: where to type what, and what to type.
@Composable
private fun Waiting(address: String, code: String, problem: String?, onSettings: () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.align(Alignment.TopEnd).padding(20.dp)) { IconKey(VI.Gear, 48.dp, onClick = onSettings) }
        Column(
            Modifier.align(Alignment.Center).widthIn(max = 620.dp).fillMaxWidth(0.9f).clip(RoundedCornerShape(22.dp)).background(V.Panel)
                .border(1.dp, V.Stroke, RoundedCornerShape(22.dp)).padding(horizontal = 34.dp, vertical = 30.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp), horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Wordmark()
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                T("Kitchen screen", 28.sp, 800, spacing = (-0.6).sp)
                T("Waiting for a till. Orders appear here when Send to kitchen is pressed.", 15.sp, 500, V.Text2, lines = 2, align = TextAlign.Center)
            }
            problem?.let { T(it, 14.sp, 600, V.RedText, Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.RedWash).padding(horizontal = 14.dp, vertical = 11.dp), lines = 4) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Fact("Address", addressOf(address) ?: "Not on Wi-Fi", Modifier.weight(1f), wide = true)
                Fact("Pairing code", spaced(code), Modifier.weight(1f), wide = true)
            }
            if (addressOf(address) == null) {
                T("This tablet is not on a network. Join the restaurant's Wi-Fi, the same one the tills are on.", 14.sp, 600, V.AmberText, lines = 3, align = TextAlign.Center)
            }
            T(
                "In the back office, under Printers, add a Kitchen screen with this address and this code. The tills have it after their next sync.",
                14.sp, 500, V.Text2, lines = 3, align = TextAlign.Center, height = 20.sp,
            )
            T("EasyPay ${BuildConfig.VERSION_NAME}", 12.sp, 500, V.Text3)
        }
    }
}

@Composable
private fun Fact(label: String, value: String, modifier: Modifier, wide: Boolean = false) {
    Column(modifier.clip(RoundedCornerShape(14.dp)).background(V.Well).padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Caps(label, V.Text2)
        T(value, if (wide) 26.sp else 20.sp, 800, lines = 2, spacing = if (wide) 2.sp else 0.sp)
    }
}

// a question before something that cannot be taken back
@Composable
private fun Confirm(title: String, text: String, yes: String, onNo: () -> Unit, onYes: () -> Unit) {
    Sheet(onNo, width = 480.dp) {
        SheetHead(title, null, onNo)
        T(text, 15.sp, 500, V.Text2, lines = 6, height = 21.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Cancel", Modifier.weight(1f), onClick = onNo)
            VBtn(yes, Modifier.weight(1f), bg = V.Red, fg = androidx.compose.ui.graphics.Color.White, onClick = onYes)
        }
    }
}
