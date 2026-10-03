package com.restopos.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.rememberCoroutineScope
import androidx.sqlite.db.SimpleSQLiteQuery
import com.restopos.core.network.AuthClient
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.SyncScheduler
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import javax.inject.Inject

// Single-activity app. Pull-on-start per spec 5.5; sign-out wipes Room and is
// blocked while the outbox is non-empty (outbox writes land in Phase 2, the
// guard is already here).
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
            AppNav(session) {
                scope.launch {
                    // Phase 2 fills the outbox; until then sign-out is direct.
                    val pending = db.openHelper.readableDatabase
                        .query(SimpleSQLiteQuery("SELECT COUNT(*) FROM outbox WHERE state = 'pending'"))
                        .use { c -> c.moveToFirst(); c.getLong(0) }
                    if (pending == 0L) {
                        auth.signOut()
                        session.clear()
                        db.clearAllTables()
                        recreate()
                    }
                }
            }
        }
    }
}
