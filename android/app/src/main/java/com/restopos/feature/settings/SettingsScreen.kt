package com.restopos.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.app.BuildConfig
import com.restopos.core.sync.SyncScheduler
import com.restopos.core.sync.pushNow
import com.restopos.core.ui.Pos

// This till, the state of its sync, and signing out.
@Composable
fun SettingsScreen(
    till: String,
    needsSignIn: Boolean,
    pending: Long,
    rejected: Long,
    onSignIn: () -> Unit,
    onRejected: () -> Unit,
    onSignOut: () -> Unit,
) {
    val context = LocalContext.current
    Column(
        Modifier.fillMaxSize().background(Pos.Bg).verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Section("This till") {
            Text(till.ifBlank { "Not set up" }, color = Pos.Text, fontSize = 16.sp)
            Text("RestoPOS ${BuildConfig.VERSION_NAME}", color = Pos.Text3, fontSize = 12.sp)
        }
        Section("Sync") {
            Text(
                when {
                    needsSignIn -> "This tablet cannot sync until someone signs in. Sales are saved here in the meantime."
                    pending > 0 -> "$pending changes are waiting to be sent. They go as soon as there is a connection."
                    else -> "Everything on this tablet has been sent."
                },
                color = Pos.Text, fontSize = 14.sp,
            )
            if (rejected > 0) Text("$rejected changes were refused by the server and need a look.", color = Pos.Pink, fontSize = 14.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (needsSignIn) Button(onClick = onSignIn) { Text("Sign in") }
                else Button(onClick = { pushNow(context); SyncScheduler.pullNow(context) }) { Text("Sync now") }
                OutlinedButton(onClick = onRejected) { Text(if (rejected > 0) "Rejected changes ($rejected)" else "Rejected changes") }
            }
        }
        Section("Session") {
            OutlinedButton(onClick = onSignOut) { Text("Sign out", color = Pos.Pink) }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Pos.Panel).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, color = Pos.Text2, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        content()
    }
}
