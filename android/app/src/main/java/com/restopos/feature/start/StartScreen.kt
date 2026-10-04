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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.restopos.app.BuildConfig
import com.restopos.core.data.StaffMember
import com.restopos.core.ui.Pos
import com.restopos.feature.staff.PinPad
import com.restopos.feature.staff.RoleBadge
import com.restopos.feature.staff.StaffTopBar
import com.restopos.feature.staff.StaffViewModel
import com.restopos.feature.staff.TillInfo
import kotlinx.coroutines.delay
import java.net.Inet4Address
import java.text.DateFormat
import java.util.Date

// What the tablet shows when the app opens, and after Log out. Three states:
//   - nobody here has a PIN yet: the register opens with one tap, as it
//     always has, so an update never locks a restaurant out;
//   - staff use PINs and nobody is clocked in: clock in first;
//   - someone is clocked in: tap your name and enter your PIN.
@Composable
fun StartScreen(
    vm: StaffViewModel = hiltViewModel(),
    onOpen: () -> Unit,
    onClock: () -> Unit,
    onCashCount: () -> Unit,
    onSignIn: () -> Unit,
) {
    val staff by vm.staff.collectAsState()
    val shift by vm.shift.collectAsState()
    val message by vm.message.collectAsState()
    var pinFor by remember { mutableStateOf<StaffMember?>(null) }
    // Back on this screen means nobody is at the register.
    LaunchedEffect(Unit) { vm.signOut() }
    message?.let { m -> LaunchedEffect(m) { delay(4000); vm.messageShown() } }

    val all = staff
    val active = all?.filter { it.clockedInAt != null }.orEmpty()
    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        when {
            all == null -> Unit // still reading the tablet's own data
            all.none { it.hasPin } -> Closed(
                vm, title = "Register is locked", text = "Open the register to take orders.", button = "Open register",
                note = "Staff PINs are not set up. Add them in the back office, under Staff, to have staff clock in and sign in here.",
                onButton = onOpen, onSignIn = onSignIn,
            )
            active.isEmpty() -> Closed(
                vm,
                title = if (shift == null) "The shift is closed" else "No one is clocked in",
                text = if (shift == null) "Clock in below to open a shift." else "Clock in below to use the register.",
                button = "Clock in/out", note = null, onButton = onClock, onSignIn = onSignIn,
            )
            else -> Users(active, shiftOpen = shift != null, openedAt = shift?.opened_at, onPick = { pinFor = it }, onClock = onClock)
        }
        message?.let { m ->
            Text(
                m,
                Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(6.dp))
                    .background(Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }

    pinFor?.let { member ->
        PinPad(
            member,
            check = { vm.checkPin(member, it) },
            onOk = {
                pinFor = null
                when {
                    shift != null -> vm.signIn(member, onOpen)
                    member.can("shift.open_close") -> vm.signIn(member, onCashCount)
                    else -> vm.say("The shift is closed. Someone allowed to open it has to sign in first.")
                }
            },
            onDismiss = { pinFor = null },
        )
    }
}

// The till's details on the left, one way in on the right.
@Composable
private fun Closed(
    vm: StaffViewModel,
    title: String,
    text: String,
    button: String,
    note: String?,
    onButton: () -> Unit,
    onSignIn: () -> Unit,
) {
    val info by vm.info.collectAsState()
    val needsSignIn by vm.needsSignIn.collectAsState()
    val pending by vm.pending.collectAsState()
    val context = LocalContext.current
    val network by produceState(initialValue = network(context)) {
        while (true) { delay(5000); value = network(context) }
    }
    Row(Modifier.fillMaxSize()) {
        Column(
            Modifier.width(300.dp).fillMaxHeight().background(Pos.Panel).padding(horizontal = 28.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Wordmark()
            Spacer(Modifier.height(28.dp))
            Facts(info, network, when {
                needsSignIn -> "Sign-in needed"
                pending > 0 -> "$pending changes waiting"
                else -> "Everything sent"
            })
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
            Text(title, color = Pos.Text, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text(text, Modifier.padding(top = 10.dp), color = Pos.Text, fontSize = 15.sp, textAlign = TextAlign.Center)
            Spacer(Modifier.height(32.dp))
            BigButton(button, Modifier.width(340.dp), onButton)
            if (note != null) {
                Text(note, Modifier.padding(top = 18.dp).width(380.dp), color = Pos.Text3, fontSize = 13.sp, textAlign = TextAlign.Center)
            }
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

// Everyone who is clocked in, as tiles: tap your name, then enter your PIN.
@Composable
private fun Users(active: List<StaffMember>, shiftOpen: Boolean, openedAt: Long?, onPick: (StaffMember) -> Unit, onClock: () -> Unit) {
    var byTime by rememberSaveable { mutableStateOf(false) }
    val shown = if (byTime) active.sortedBy { it.clockedInAt } else active
    Column(Modifier.fillMaxSize()) {
        StaffTopBar("RestoPOS")
        Column(Modifier.weight(1f).fillMaxWidth().padding(start = 64.dp, end = 64.dp, top = 28.dp, bottom = 28.dp)) {
            Wordmark()
            Row(Modifier.fillMaxWidth().padding(top = 22.dp, bottom = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (shiftOpen) "Welcome! Tap your name, or clock in/out."
                    else "Welcome! The shift is closed. Tap your name to open it, or clock in/out.",
                    Modifier.weight(1f), color = Pos.Text, fontSize = 14.sp,
                )
                Text("Sort by", Modifier.padding(end = 12.dp), color = Pos.Text, fontSize = 14.sp)
                Row(Modifier.clip(RoundedCornerShape(4.dp))) {
                    SortKey("A–Z", !byTime) { byTime = false }
                    SortKey("Clocked in", byTime) { byTime = true }
                }
            }
            LazyVerticalGrid(
                GridCells.Adaptive(190.dp), Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                items(shown, key = { it.employee.id }) { m ->
                    Column(
                        Modifier.height(74.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Tile.copy(alpha = 0.75f))
                            .clickable { onPick(m) }.padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(m.employee.name, color = Pos.Text, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        RoleBadge(m.role)
                    }
                }
            }
            if (openedAt != null) {
                Text(
                    "Shift open since ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(openedAt))}",
                    Modifier.padding(bottom = 12.dp), color = Pos.Text3, fontSize = 13.sp,
                )
            }
            BigButton("Clock in/out", Modifier.width(280.dp), onClock)
        }
    }
}

@Composable
private fun SortKey(label: String, on: Boolean, onClick: () -> Unit) {
    Text(
        label, Modifier.background(if (on) Pos.Blue else Pos.Key).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 9.dp),
        color = if (on) Color.White else Pos.Text2, fontSize = 13.sp, fontWeight = FontWeight.Medium,
    )
}

@Composable
private fun Wordmark() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(34.dp).clip(RoundedCornerShape(9.dp)).background(Pos.Blue), contentAlignment = Alignment.Center) {
            Text("R", color = Color.White, fontSize = 19.sp, fontWeight = FontWeight.Bold)
        }
        Text("RestoPOS", Modifier.padding(start = 10.dp), color = Pos.Text, fontSize = 28.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun BigButton(label: String, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier.height(54.dp).clip(RoundedCornerShape(4.dp)).background(Pos.Blue).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold) }
}

@Composable
private fun Facts(info: TillInfo, network: String, sync: String) {
    Fact("Business name", info.business ?: "—")
    Fact("Store", info.store ?: "—")
    Fact("Device info", info.device ?: "—")
    Fact("Software version", "RestoPOS ${BuildConfig.VERSION_NAME}")
    Fact("Network", network)
    Fact("Sync", sync)
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
