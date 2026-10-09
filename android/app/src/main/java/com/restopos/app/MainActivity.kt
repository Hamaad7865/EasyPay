package com.restopos.app

import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Surface
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import com.restopos.core.data.PosSettings
import com.restopos.core.network.AuthClient
import com.restopos.core.sync.Quiet
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.SyncScheduler
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosTheme
import com.restopos.feature.staff.ApprovalHost
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

// Single-activity app. Pull-on-start per spec 5.5; sign-out wipes Room and is
// blocked while the outbox is non-empty.
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var session: SessionStore
    @Inject lateinit var auth: AuthClient
    @Inject lateinit var api: com.restopos.core.network.ApiClient
    @Inject lateinit var staff: com.restopos.core.data.StaffSession
    @Inject lateinit var staffRepo: com.restopos.core.data.StaffRepository
    @Inject lateinit var db: com.restopos.core.database.TillDatabase

    // The screens are drawn for a 1280 x 720dp landscape tablet and scaled to
    // the tablet they run on: a 15-inch till shows the same layout larger,
    // instead of the same sizes lost in empty space. The smaller of the two
    // ratios is used, so a wide 16:10 tablet keeps the height the order list
    // and keypad need. Done on the activity's configuration rather than in
    // Compose, so dialogs and menus (separate windows) scale as well.
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(newBase)
        val base = newBase.resources.configuration
        val width = maxOf(base.screenWidthDp, base.screenHeightDp)
        val height = minOf(base.screenWidthDp, base.screenHeightDp)
        val scale = minOf(width / 1280f, height / 720f).coerceIn(0.6f, 2f)
        applyOverrideConfiguration(Configuration().apply {
            densityDpi = (base.densityDpi * scale).toInt()
            screenWidthDp = (base.screenWidthDp / scale).toInt()
            screenHeightDp = (base.screenHeightDp / scale).toInt()
            smallestScreenWidthDp = (base.smallestScreenWidthDp / scale).toInt()
        })
    }

    // Keys from a keyboard or a scanner go to the screen as always. The Enter
    // that ends a scan is kept from it (it would press whatever has the focus)
    // and the code goes to the order screen instead.
    //
    // In scan mode (a shop's Sell, Receipts and Stock check, with the scan key
    // lit) nothing of a scan reaches the screen: every key is taken here,
    // before anything that has the focus sees it, and put together into the
    // code. Nothing is typed, so nothing asks for the keyboard. The releases
    // are taken too: a key that has the focus would take a scanner's Enter
    // coming up as a press of itself.
    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
        if (event.action == android.view.KeyEvent.ACTION_DOWN) used()
        val scanner = com.restopos.core.common.Scanner
        if (scanner.capturing && event.device?.isVirtual == false) {
            val ends = event.keyCode == android.view.KeyEvent.KEYCODE_ENTER || event.keyCode == android.view.KeyEvent.KEYCODE_NUMPAD_ENTER || event.keyCode == android.view.KeyEvent.KEYCODE_TAB
            val rubs = event.keyCode == android.view.KeyEvent.KEYCODE_DEL || event.keyCode == android.view.KeyEvent.KEYCODE_FORWARD_DEL
            // keys with no character (volume, back and the rest) go on as always
            if (!ends && !rubs && event.unicodeChar == 0) return super.dispatchKeyEvent(event)
            if (event.action == android.view.KeyEvent.ACTION_DOWN) {
                when {
                    ends -> scanner.wedge.enter()?.let { scanner.scanned(it) }
                    rubs -> scanner.wedge.backspace()
                    else -> scanner.wedge.key(event.unicodeChar, event.eventTime)
                }
            }
            return true
        }
        if (event.action == android.view.KeyEvent.ACTION_DOWN && event.device?.isVirtual == false) {
            val enter = event.keyCode == android.view.KeyEvent.KEYCODE_ENTER || event.keyCode == android.view.KeyEvent.KEYCODE_NUMPAD_ENTER
            com.restopos.core.common.Scanner.key(event.unicodeChar, enter, event.eventTime)?.let { code ->
                com.restopos.core.common.Scanner.scanned(code)
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    // Someone is at the till: a finger, a key, a scan, or the till coming to
    // the front. The sync every 15 minutes asks the server for news only
    // while that is so, because the database it wakes is paid for by the hour
    // (core/sync/Quiet). The first sign of someone after the till was left
    // alone syncs at once, so what changed in the back office meanwhile is
    // there. It is written to the tablet's storage once a minute at most: a
    // busy service is hundreds of touches a minute.
    private var seen: Long? = null
    private var noted: Long? = null
    private fun used() {
        val now = System.currentTimeMillis()
        if (Quiet.back(now, seen)) SyncScheduler.pullNow(this)
        seen = now
        if (Quiet.notes(now, noted)) {
            noted = now
            lifecycleScope.launch { session.setLastUse(now) }
        }
    }

    override fun dispatchTouchEvent(ev: android.view.MotionEvent): Boolean {
        if (ev.actionMasked == android.view.MotionEvent.ACTION_DOWN) used()
        return super.dispatchTouchEvent(ev)
    }

    override fun onResume() {
        super.onResume()
        used()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The till's and the kitchen screen's sounds are played as an alarm is
        // (Chime), so that a tablet with its notifications down still makes
        // them. While EasyPay is open the tablet's volume keys set that volume.
        volumeControlStream = android.media.AudioManager.STREAM_ALARM
        SyncScheduler.pullNow(this)
        setContent {
            val scope = rememberCoroutineScope()
            // A till that goes to sleep between orders is a nuisance; Settings, Display can let it.
            val awake by session.keepAwake.collectAsState(initial = true)
            LaunchedEffect(awake) {
                if (awake) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            // Light or dark (Settings, Display): the colours follow, and so do the clock and
            // battery along the top, which are dark on a light screen.
            val light by session.lightMode.collectAsState(initial = false)
            LaunchedEffect(light) {
                Pos.light = light
                WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = light
                WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightNavigationBars = light
            }
            PosTheme {
                // clear of the status bar and the gesture bar
                Box(Modifier.fillMaxSize().background(Pos.Bg).safeDrawingPadding()) {
                Surface(color = Pos.Bg) {
                    AppNav(
                        session,
                        signedIn = { staff.current.value != null },
                        pinsInUse = { session.storeId()?.let { staffRepo.pinsInUse(it).first() } ?: false },
                    ) {
                        scope.launch {
                            // Unsynced sales exist only on this tablet: signing out
                            // would wipe them, so it is refused until they are pushed.
                            val pending = db.outbox().pendingCount()
                            if (pending > 0L) {
                                Toast.makeText(this@MainActivity, "$pending changes still to sync. Connect, then sign out.", Toast.LENGTH_LONG).show()
                                return@launch
                            }
                            // Refused changes exist only here until a manager has seen them.
                            val refused = db.outbox().deadCount()
                            if (refused > 0L) {
                                Toast.makeText(this@MainActivity, "$refused rejected changes need a look first (Settings, Rejected changes).", Toast.LENGTH_LONG).show()
                                return@launch
                            }
                            // An open order is only on this tablet: wiping it would
                            // leave it unpaid on the server with no till able to charge it.
                            val unpaid = db.tickets().unpaidOrderCount()
                            if (unpaid > 0L) {
                                // a shop has sales, the one on the screen and those under Parked, and no Orders key
                                val said = if (PosSettings.parse(db.ops().settings()).retail)
                                    "$unpaid ${if (unpaid == 1L) "sale is" else "sales are"} not paid yet, on the screen or under Parked. Take payment or clear ${if (unpaid == 1L) "it" else "them"}, then sign out."
                                else "$unpaid open orders are not paid yet. Take payment or void their lines (Orders), then sign out."
                                Toast.makeText(this@MainActivity, said, Toast.LENGTH_LONG).show()
                                return@launch
                            }
                            SyncScheduler.stop(this@MainActivity)
                            api.endTillKey() // the till's own key ends with the sign-out
                            auth.signOut() // best effort on the server, always clears locally
                            session.clear()
                            // clearAllTables() blocks; Room refuses it on the main thread.
                            withContext(Dispatchers.IO) { db.clearAllTables() }
                            // Nobody is at a till that belongs to no business any more.
                            staff.signOut()
                            // Start again from nothing, on the sign-in screen. recreate()
                            // did not: Android hands a recreated screen what it was
                            // showing, so the till came back on the page it was signed
                            // out from, with nothing behind it, and the sign-out looked
                            // as if it had done nothing.
                            startActivity(
                                android.content.Intent(this@MainActivity, MainActivity::class.java)
                                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK),
                            )
                            finish()
                        }
                    }
                    // someone else's PIN, over whatever screen asked for it
                    ApprovalHost()
                }
                }
            }
        }
    }
}
