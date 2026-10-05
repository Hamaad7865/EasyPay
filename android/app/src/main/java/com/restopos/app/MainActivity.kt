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
import com.restopos.core.network.AuthClient
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
                                Toast.makeText(this@MainActivity, "$unpaid open orders are not paid yet. Take payment or void their lines (Orders), then sign out.", Toast.LENGTH_LONG).show()
                                return@launch
                            }
                            SyncScheduler.stop(this@MainActivity)
                            auth.signOut() // best effort on the server, always clears locally
                            session.clear()
                            // clearAllTables() blocks; Room refuses it on the main thread.
                            withContext(Dispatchers.IO) { db.clearAllTables() }
                            recreate()
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
