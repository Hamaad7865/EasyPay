package com.restopos.feature.start

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.app.BuildConfig
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.ApiClient
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Pos
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.net.Inet4Address
import javax.inject.Inject

data class TillInfo(val business: String? = null, val store: String? = null, val device: String? = null)

@HiltViewModel
class StartViewModel @Inject constructor(
    private val session: SessionStore,
    private val db: TillDatabase,
    private val api: ApiClient,
) : ViewModel() {
    private val _info = MutableStateFlow(TillInfo())
    val info: StateFlow<TillInfo> = _info

    val needsSignIn: StateFlow<Boolean> = session.needsSignIn
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    val pending: StateFlow<Long> = db.outbox().pendingCountFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    init {
        viewModelScope.launch {
            val store = session.storeId()?.let { db.catalog().store(it) }
            val device = session.deviceId()?.let { db.catalog().device(it) }
            _info.value = TillInfo(
                business = session.businessName(),
                store = store?.name,
                device = device?.let { if (it.name == it.code) it.code else "${it.name} (${it.code})" },
            )
            // A till set up before the name was kept: ask once, when online.
            if (_info.value.business == null) {
                runCatching { api.me() }.onSuccess { me ->
                    me.tenants.firstOrNull { it.id == me.tenantId }?.name?.let { name ->
                        session.setBusinessName(name)
                        _info.value = _info.value.copy(business = name)
                    }
                }
            }
        }
    }
}

// What the tablet shows when the app opens, and when the register is locked:
// which till this is on the left, and the way in on the right.
@Composable
fun StartScreen(vm: StartViewModel = hiltViewModel(), onOpen: () -> Unit, onSignIn: () -> Unit) {
    val info by vm.info.collectAsState()
    val needsSignIn by vm.needsSignIn.collectAsState()
    val pending by vm.pending.collectAsState()
    val context = LocalContext.current
    val network by produceState(initialValue = network(context)) {
        while (true) { delay(5000); value = network(context) }
    }
    Row(Modifier.fillMaxSize().background(Pos.Bg)) {
        Column(
            Modifier.width(300.dp).fillMaxHeight().background(Pos.Panel).padding(horizontal = 28.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(34.dp).clip(RoundedCornerShape(9.dp)).background(Pos.Blue), contentAlignment = Alignment.Center) {
                    Text("R", color = Color.White, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                }
                Text("RestoPOS", Modifier.padding(start = 10.dp), color = Pos.Text, fontSize = 28.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(28.dp))
            Fact("Business name", info.business ?: "—")
            Fact("Store", info.store ?: "—")
            Fact("Device info", info.device ?: "—")
            Fact("Software version", "RestoPOS ${BuildConfig.VERSION_NAME}")
            Fact("Network", network)
            Fact(
                "Sync",
                when {
                    needsSignIn -> "Sign-in needed"
                    pending > 0 -> "$pending changes waiting"
                    else -> "Everything sent"
                },
            )
        }
        Column(
            Modifier.weight(1f).fillMaxHeight().padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(Modifier.size(132.dp).clip(RoundedCornerShape(28.dp)).background(Pos.Key), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.ShoppingCart, contentDescription = null, tint = Pos.NavOn, modifier = Modifier.size(64.dp))
            }
            Spacer(Modifier.height(28.dp))
            Text("Register is locked", color = Pos.Text, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text(
                "Open the register to take orders.",
                Modifier.padding(top = 10.dp), color = Pos.Text, fontSize = 15.sp, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(32.dp))
            Box(
                Modifier.width(340.dp).height(54.dp).clip(RoundedCornerShape(4.dp)).background(Pos.Blue).clickable(onClick = onOpen),
                contentAlignment = Alignment.Center,
            ) { Text("Open register", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold) }
            if (needsSignIn) {
                Text(
                    "This tablet cannot sync until someone signs in. Sales are saved here in the meantime.",
                    Modifier.padding(top = 20.dp).width(340.dp), color = Pos.Pink, fontSize = 13.sp, textAlign = TextAlign.Center,
                )
                Text("Sign in", Modifier.clickable(onClick = onSignIn).padding(10.dp), color = Pos.NavOn, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun Fact(label: String, value: String) {
    Text(label, color = Pos.Text3, fontSize = 13.sp)
    Text(value, Modifier.padding(top = 3.dp, bottom = 14.dp), color = Pos.Text, fontSize = 15.sp)
}

// "Wi-Fi, 10.0.0.196", or "Offline".
private fun network(context: Context): String {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return "Unknown"
    val net = cm.activeNetwork ?: return "Offline"
    val caps = cm.getNetworkCapabilities(net)
    val kind = when {
        caps == null -> "Online"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Mobile data"
        else -> "Online"
    }
    val ip = cm.getLinkProperties(net)?.linkAddresses?.firstOrNull { it.address is Inet4Address }?.address?.hostAddress
    return listOfNotNull(kind, ip).joinToString(", ")
}
