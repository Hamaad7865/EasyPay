package com.restopos.feature.setup

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.data.PosSettings
import com.restopos.core.data.SetupDoor
import com.restopos.core.data.SetupSteps
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.SyncScheduler
import com.restopos.core.ui.V
import com.restopos.feature.auth.Heading
import com.restopos.feature.auth.MainKey
import com.restopos.feature.auth.Problem
import com.restopos.feature.auth.QuietLink
import com.restopos.feature.auth.SetupCard
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

// Between "Name this till" and whatever comes next. A tablet that was just
// registered holds nothing of its business: its products, its staff and its
// settings come with its first pull. Until a whole pull has finished since it
// was registered nothing is decided (SetupSteps.after). Then the business's
// own mark says whether the tablet opens on the set-up or on the till.
@HiltViewModel
class SetupWaitViewModel @Inject constructor(
    private val session: SessionStore,
    private val db: TillDatabase,
    door: SetupDoor,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    // a first run is opened by nobody's PIN
    init { door.approver = null }

    val business: StateFlow<String> = flow { emit(session.businessName().orEmpty()) }.stateIn(viewModelScope, SharingStarted.Eagerly, "")

    // The settings are read from the database itself once the pull is in, not
    // from a flow of them: the pull writes them before it says it has
    // finished, and a flow might still be holding what was there before.
    val after: StateFlow<SetupSteps.After> = session.lastPull.map { pull ->
        val at = session.registeredAt()
        if (pull == null || pull < at) SetupSteps.After.Wait else SetupSteps.after(at, pull, PosSettings.parse(db.ops().settings()))
    }.stateIn(viewModelScope, SharingStarted.Eagerly, SetupSteps.After.Wait)

    fun again() = SyncScheduler.pullNow(context)
}

@Composable
fun SetupWaitScreen(onSetUp: () -> Unit, onTill: () -> Unit, vm: SetupWaitViewModel = hiltViewModel()) {
    val after by vm.after.collectAsState()
    val business by vm.business.collectAsState()
    // twenty seconds without a finished pull is too long to say nothing
    var slow by remember { mutableStateOf(false) }
    var tries by remember { mutableStateOf(0) }
    LaunchedEffect(after) {
        when (after) {
            SetupSteps.After.SetUp -> onSetUp()
            SetupSteps.After.Till -> onTill()
            SetupSteps.After.Wait -> Unit
        }
    }
    LaunchedEffect(tries) { slow = false; delay(20_000); slow = true }

    SetupCard {
        Heading(
            if (business.isBlank()) "Getting the till ready" else "Getting $business ready",
            "Reading its products, staff and settings. This takes a moment.",
        )
        if (slow) {
            Problem("This is taking longer than it should. Check the tablet's connection.")
            MainKey("Try again", ready = true, busy = false) { vm.again(); tries++ }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                QuietLink("Open the till", enabled = true, onClick = onTill)
            }
        } else {
            Box(Modifier.fillMaxWidth().height(96.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(28.dp), color = V.Cyan, strokeWidth = 2.5.dp)
            }
        }
    }
}
