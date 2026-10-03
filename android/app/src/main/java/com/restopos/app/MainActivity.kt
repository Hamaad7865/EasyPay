package com.restopos.app

import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.rememberCoroutineScope
import com.restopos.core.network.AuthClient
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.SyncScheduler
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

// Single-activity app. Pull-on-start per spec 5.5; sign-out wipes Room and is
// blocked while the outbox is non-empty.
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var session: SessionStore
    @Inject lateinit var auth: AuthClient
    @Inject lateinit var db: com.restopos.core.database.TillDatabase

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SyncScheduler.pullNow(this)
        setContent {
            val scope = rememberCoroutineScope()
            MaterialTheme {
                Surface {
                    AppNav(session) {
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
                                Toast.makeText(this@MainActivity, "$refused rejected changes need a look first (menu, Rejected changes).", Toast.LENGTH_LONG).show()
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
                }
            }
        }
    }
}
