package com.restopos.feature.display

import android.content.Context
import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.app.BuildConfig
import com.restopos.core.common.AppUpdate
import com.restopos.core.common.Money
import com.restopos.core.display.DisplayBook
import com.restopos.core.display.DisplayWire
import com.restopos.core.display.PicLine
import com.restopos.core.display.Picture
import com.restopos.core.kitchen.PairCode
import com.restopos.core.kitchen.ScreenServer
import com.restopos.core.network.ApiClient
import com.restopos.core.sync.AppUpdater
import com.restopos.core.sync.Download
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.L
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.ToastHost
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.Wordmark
import com.restopos.feature.kds.Confirm
import com.restopos.feature.kds.Fact
import com.restopos.feature.kds.KitchenUpdate
import com.restopos.feature.kds.PrefRow
import com.restopos.feature.kds.Switch
import com.restopos.feature.kds.addressOf
import com.restopos.feature.kds.spaced
import com.restopos.feature.start.network
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import javax.inject.Inject

// A tablet set up as a customer display: it faces the customer and shows the
// sale of the till it is paired with, as it is rung up, the change after Pay,
// and the business's name, logo and message between sales. No login, no
// sales of its own. It listens on the shop's Wi-Fi (ScreenServer, port 9311)
// and draws what its book (DisplayBook) says is on screen. It sends our
// server nothing, and asks it one thing: whether a newer EasyPay exists.

@HiltViewModel
class DisplayModeViewModel @Inject constructor(
    private val session: SessionStore,
    private val api: ApiClient,
    private val updater: AppUpdater,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    // the logo, kept so that it is there after a restart before any till has spoken
    private val logoFile = File(context.filesDir, "display_logo.txt")
    private val book = DisplayBook(code = { session.pairCode() }, build = BuildConfig.VERSION_CODE, keepLogo = { logo, _ ->
        withContext(Dispatchers.IO) { runCatching { if (logo == null) logoFile.delete() else logoFile.writeText(logo) } }
    })
    private val server = ScreenServer(DisplayWire.PORT) { first, second -> book.answer(first, second) }

    val problem = MutableStateFlow<String?>(null)
    val address = MutableStateFlow(network(context))
    val code: StateFlow<String> = session.pairCode.map { it.orEmpty() }.stateIn(viewModelScope, SharingStarted.Eagerly, "")
    val light: StateFlow<Boolean> = session.lightMode.stateIn(viewModelScope, SharingStarted.Eagerly, true)
    val update = MutableStateFlow<KitchenUpdate>(KitchenUpdate.None)
    private val tick = MutableStateFlow(System.currentTimeMillis())

    // what is on screen: null until a till has spoken to it (the pairing page)
    val shown: StateFlow<Picture?> = combine(book.held, tick) { _, now -> book.shown(now) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)
    val logo: StateFlow<ImageBitmap?> = book.logo.map { decode(it) }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    init {
        viewModelScope.launch {
            val kept = withContext(Dispatchers.IO) { runCatching { logoFile.takeIf { it.exists() }?.readText() }.getOrNull() }
            if (kept != null && book.logo.value == null) book.restore(kept)
        }
        listen()
        // the clock the idle screen goes by, and the address, which a router may change
        viewModelScope.launch {
            var n = 0
            while (true) {
                delay(1000)
                tick.value = System.currentTimeMillis()
                if (++n % 5 == 0) {
                    address.value = network(context)
                    if (!server.listening) listen()
                }
            }
        }
        viewModelScope.launch { look() }
    }

    private fun listen() {
        problem.value = runCatching { server.start(viewModelScope) }.exceptionOrNull()?.let {
            "This tablet cannot listen for its till: port ${DisplayWire.PORT} is in use. Close EasyPay, open it again, and if this stays, restart the tablet."
        }
    }

    override fun onCleared() { server.stop() }

    fun setLight(on: Boolean) = viewModelScope.launch { session.setLightMode(on) }

    // A new code: the till is refused until it has been given it.
    fun newCode() = viewModelScope.launch {
        session.setPairCode(PairCode.make())
        book.forget()
        withContext(Dispatchers.IO) { runCatching { logoFile.delete() } }
        Toaster.say("New pairing code. Type it where this display was added (the back office, under Printers): until then the till cannot show its sale here.")
    }

    // The tablet stops being a display: nothing it was sent is kept.
    fun becomeTill(then: () -> Unit) = viewModelScope.launch {
        server.stop()
        book.forget()
        withContext(Dispatchers.IO) { runCatching { logoFile.delete() } }
        session.leaveDisplay()
        then()
    }

    // ---- a newer EasyPay: asked of GET /health, which needs no login (as on a kitchen screen) ----
    private suspend fun look() {
        runCatching { AppUpdate.newer(BuildConfig.VERSION_CODE, api.latestTill()) }.getOrNull()?.let { r ->
            if (update.value is KitchenUpdate.None) update.value = KitchenUpdate.Offered(r)
        }
    }

    fun fetchUpdate() {
        val r = (update.value as? KitchenUpdate.Offered)?.release ?: return
        if (!updater.start(r.version, r.url)) {
            Toaster.say("This tablet would not start the download. The display goes on working as it is.")
            return
        }
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

    private fun decode(data: String?): ImageBitmap? = data?.let {
        runCatching {
            val bytes = android.util.Base64.decode(it.substringAfter(','), android.util.Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()
    }
}

@Composable
fun DisplayModeScreen(vm: DisplayModeViewModel = hiltViewModel(), onBecomeTill: () -> Unit) {
    val shown by vm.shown.collectAsState()
    val logo by vm.logo.collectAsState()
    val address by vm.address.collectAsState()
    val code by vm.code.collectAsState()
    val problem by vm.problem.collectAsState()
    val update by vm.update.collectAsState()
    val light by vm.light.collectAsState()
    var settings by remember { mutableStateOf(false) }
    var asking by remember { mutableStateOf<String?>(null) }
    // A display is the tablet's one purpose: Back does not leave it.
    BackHandler {}

    Box(Modifier.fillMaxSize().background(V.Bg).systemBarsPadding()) {
        val p = shown
        if (p == null) Waiting(address, code, problem) else CustomerScreen(p, logo)
        if (p != null) problem?.let { T(it, 14.sp, 600, V.RedText, Modifier.align(Alignment.TopCenter).fillMaxWidth().background(V.RedWash).padding(horizontal = 24.dp, vertical = 10.dp), lines = 3) }
        Box(Modifier.align(Alignment.BottomEnd).padding(14.dp)) { IconKey(VI.Gear, 40.dp, onClick = { settings = true }) }
        ToastHost()
    }

    if (settings) Sheet({ settings = false }, width = 560.dp) {
        SheetHead("Customer display", "Kept on this tablet. Its name, its message and the till it faces are set where it was added.") { settings = false }
        Switch("Light screen", "Light suits a bright counter; dark a dim room.", light) { vm.setLight(!light) }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Caps("This tablet", V.Text2)
            PrefRow("Address", "The till finds the display at this address. Keep it the same on the router, as for a printer.") { T(addressOf(address) ?: "Not on Wi-Fi", 16.sp, 700, lines = 2) }
            PrefRow("Pairing code", "Typed with the address where the display is added.") { T(spaced(code), 18.sp, 800, spacing = 2.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Make a new code", Modifier.weight(1f), height = 48.dp) { asking = "code" }
                VBtn("Use as a till instead", Modifier.weight(1f), height = 48.dp) { asking = "till" }
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Caps("EasyPay ${BuildConfig.VERSION_NAME}", V.Text2)
            when (val u = update) {
                KitchenUpdate.None -> T("This tablet has the newest EasyPay it has been told of.", 13.sp, 500, V.Text2, lines = 2)
                is KitchenUpdate.Offered -> PrefRow("EasyPay ${u.release.name} is ready to download", "The till and this display should be on the same version.") {
                    VBtn("Download", height = 46.dp, bg = V.Blue, fg = Color.White) { vm.fetchUpdate() }
                }
                is KitchenUpdate.Fetching -> T("Downloading EasyPay ${u.release.name}. The display goes on working.", 13.sp, 500, V.Text2, lines = 2)
                is KitchenUpdate.Ready -> PrefRow("EasyPay ${u.release.name} is here", "Installing takes a moment.") {
                    VBtn("Install", height = 46.dp, bg = V.Blue, fg = Color.White) { vm.installUpdate() }
                }
            }
        }
    }

    when (asking) {
        "code" -> Confirm(
            "Make a new pairing code?", "The till will be refused by this display until the new code has been typed where the display was added, and the till has it.",
            "Make a new code", onNo = { asking = null },
        ) { asking = null; vm.newCode() }
        "till" -> Confirm(
            "Use this tablet as a till instead?", "It stops being a customer display and opens on the sign-in screen.",
            "Yes, make it a till", onNo = { asking = null },
        ) { asking = null; settings = false; vm.becomeTill(onBecomeTill) }
    }
}

// Before any till has spoken to it: where to type what, and what to type.
@Composable
private fun Waiting(address: String, code: String, problem: String?) {
    Box(Modifier.fillMaxSize()) {
        Column(
            Modifier.align(Alignment.Center).widthIn(max = 640.dp).fillMaxWidth(0.9f).clip(RoundedCornerShape(22.dp)).background(V.Panel)
                .border(1.dp, V.Stroke, RoundedCornerShape(22.dp)).padding(horizontal = 34.dp, vertical = 30.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp), horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Wordmark()
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                T("Customer display", 28.sp, 800, spacing = (-0.6).sp)
                T("Waiting for its till. The sale shows here as it is rung up.", 15.sp, 500, V.Text2, lines = 2, align = TextAlign.Center)
            }
            problem?.let { T(it, 14.sp, 600, V.RedText, Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.RedWash).padding(horizontal = 14.dp, vertical = 11.dp), lines = 4) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Fact("Address", addressOf(address) ?: "Not on Wi-Fi", Modifier.weight(1f), wide = true)
                Fact("Pairing code", spaced(code), Modifier.weight(1f), wide = true)
            }
            if (addressOf(address) == null) {
                T("This tablet is not on a network. Join the shop's Wi-Fi, the same one the till is on.", 14.sp, 600, V.AmberText, lines = 3, align = TextAlign.Center)
            }
            T(
                "In the back office, under Printers, add a customer display with this address and this code, and the till it faces. " +
                    "A tablet that works on its own adds it itself: on the till, Settings, Printers, Add a customer display.",
                14.sp, 500, V.Text2, lines = 4, align = TextAlign.Center, height = 20.sp,
            )
            T("EasyPay ${BuildConfig.VERSION_NAME}", 12.sp, 500, V.Text3)
        }
    }
}
