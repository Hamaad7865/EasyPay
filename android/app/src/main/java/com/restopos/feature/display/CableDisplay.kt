package com.restopos.feature.display

import android.app.Presentation
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Display
import androidx.activity.ComponentActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.restopos.core.display.DisplayFeed
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.launch

// The customer display on a second screen joined to this till by a cable: a
// monitor on the tablet's HDMI or USB-C, or a terminal's own customer screen,
// anything Android itself offers for a presentation. Drawn by the same
// CustomerScreen as a tablet set up as a customer display, and fed straight
// from this till's DisplayFeed: no Wi-Fi, no pairing, no code. Switched on in
// Settings, Printers, and kept on this tablet (SessionStore.cableDisplay).
//
// Started by the activity of a tablet that is a till (not a kitchen screen
// nor a customer display itself), for as long as that activity lives.
class CableDisplay(
    private val activity: ComponentActivity,
    private val feed: DisplayFeed,
    private val session: SessionStore,
    private val posters: com.restopos.core.display.DisplayPictures,
) : DisplayManager.DisplayListener {
    private val displays = activity.getSystemService(DisplayManager::class.java)
    private var on = false
    private var shown: Presentation? = null

    fun start() {
        activity.lifecycleScope.launch {
            if (session.isKitchen() || session.isDisplay()) return@launch
            displays.registerDisplayListener(this@CableDisplay, Handler(Looper.getMainLooper()))
            activity.lifecycle.addObserver(LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_DESTROY) stop() })
            session.cableDisplay.collect { on = it; refresh() }
        }
    }

    private fun stop() {
        displays.unregisterDisplayListener(this)
        shown?.dismiss()
        shown = null
    }

    // The first screen Android offers for a presentation, while the switch is
    // on; none when it is off or the cable is pulled out.
    private fun refresh() {
        val d = if (on) displays.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION).firstOrNull() else null
        if (d == null) {
            shown?.dismiss()
            shown = null
            return
        }
        if (shown?.isShowing == true && shown?.display?.displayId == d.displayId) return
        shown?.dismiss()
        shown = runCatching { Screen(d).also { it.show() } }.getOrNull()
    }

    override fun onDisplayAdded(displayId: Int) = refresh()
    override fun onDisplayRemoved(displayId: Int) = refresh()
    override fun onDisplayChanged(displayId: Int) {}

    private inner class Screen(display: Display) : Presentation(activity, display) {
        override fun onCreate(savedInstanceState: Bundle?) {
            super.onCreate(savedInstanceState)
            setContentView(ComposeView(context).apply {
                // a ComposeView outside the activity's own window has to be told whose lifecycle it lives by
                setViewTreeLifecycleOwner(activity)
                setViewTreeSavedStateRegistryOwner(activity)
                setViewTreeViewModelStoreOwner(activity)
                setContent {
                    val live = remember { feed.live() }
                    val picture by live.collectAsState(null)
                    val message by session.cableMessage.collectAsState("")
                    val logoData by feed.logo.collectAsState(null)
                    val logo = remember(logoData) { decodePicture(logoData) }
                    val rowsFlow = remember { posters.of(com.restopos.core.display.DisplayPictures.CABLE) }
                    val rows by rowsFlow.collectAsState(emptyList())
                    val pictures = remember(rows.map { it.hash }) {
                        rows.mapNotNull { r -> runCatching { android.graphics.BitmapFactory.decodeByteArray(r.jpeg, 0, r.jpeg.size)?.asImageBitmap() }.getOrNull() }
                    }
                    picture?.let { CustomerScreen(it.copy(message = message), logo, pictures) }
                }
            })
        }
    }
}
