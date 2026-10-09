package com.restopos.feature.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restopos.core.ui.Gap
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.press

// Setting a tablet up: sign in with the business's login, then say which
// store the till is in and what it is called. Both steps are one card in the
// middle of the screen, the same shape, so the second reads as the next step
// of the first. This is not the daily sign-in (that is a PIN on the start
// screen): it is seen when a tablet is installed, and again only if its login
// is signed out or switched off.

@Composable
fun AuthScreen(
    vm: AuthViewModel = hiltViewModel(),
    reauth: Boolean = false,
    onCancel: (() -> Unit)? = null,
    // The tablet is to be a kitchen screen, not a till: offered when a tablet
    // is first set up, never when a till is being signed in again.
    onKitchen: (() -> Unit)? = null,
    onSignedIn: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    // Navigation is a side effect of the state, run once when it becomes SignedIn.
    LaunchedEffect(state) { if (state is AuthUiState.SignedIn) onSignedIn() }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var shown by remember { mutableStateOf(false) }
    // the "forgot password" step: the same card asking only for the email
    var forgot by remember { mutableStateOf(false) }
    val busy = state == AuthUiState.Busy || state == AuthUiState.SignedIn
    val problem = (state as? AuthUiState.Error)?.message
    // Sending puts the keyboard away: on a landscape tablet it covers the
    // lower half of the screen, which is where the answer would be.
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val send: (AuthAction) -> Unit = { action ->
        if (!busy) {
            keyboard?.hide()
            focus.clearFocus()
            vm.onAction(action)
        }
    }
    val toSignIn: () -> Unit = { forgot = false; vm.onAction(AuthAction.Clear) }
    val signIn: () -> Unit = { send(AuthAction.SignIn(email, password)) }
    val sendLink: () -> Unit = { send(AuthAction.Forgot(email)) }
    val sent = state as? AuthUiState.LinkSent

    SetupCard {
        if (sent != null) {
            Heading("Check your email", "If ${sent.email} is an EasyPay login, a link to choose a new password is on its way to it.")
            T(
                "Open the link on a phone or a computer, choose the password, then sign in here with it. Nothing after a few minutes? Look in the spam folder.",
                14.sp, 500, V.Text2, lines = 4, height = 20.sp,
            )
            MainKey("Back to sign in", ready = true, busy = false, onClick = toSignIn)
            return@SetupCard
        }
        Heading(
            if (forgot) "Forgot your password?" else if (reauth) "Sign in again" else "Set up this till",
            if (forgot) "Enter the email you sign in with. We will send it a link to choose a new password."
            else if (reauth) "Everything sold on this tablet is saved, and goes up once you are signed in."
            else "Sign in with the login EasyPay gave you. After this, staff use their own PIN.",
        )
        // What went wrong is said above the boxes, so it shows whether or not the keyboard is up.
        problem?.let { Problem(it) }
        SetupField(
            "Email", email, { email = it }, "name@business.mu", enabled = !busy,
            keyboard = KeyboardType.Email, ime = if (forgot) ImeAction.Done else ImeAction.Next, onIme = { if (forgot) sendLink() },
        )
        if (!forgot) {
            SetupField(
                "Password", password, { password = it }, "Your password", enabled = !busy,
                keyboard = KeyboardType.Password, ime = ImeAction.Done, onIme = signIn, masked = !shown,
                // the eye: show what was typed, or hide it again
                trailing = {
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).press { shown = !shown }, contentAlignment = Alignment.Center) {
                        VIcon(if (shown) EYE_OFF else EYE, 20.dp, V.Text2)
                    }
                },
            )
        }
        val ready = email.isNotBlank() && (forgot || password.isNotEmpty())
        MainKey(
            if (!ready) (if (forgot) "Enter your email" else "Enter your email and password") else if (forgot) "Send the link" else "Sign in",
            ready = ready, busy = busy, onClick = if (forgot) sendLink else signIn,
        )
        val canForget = !forgot && vm.canReset
        if (forgot || canForget || onCancel != null) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                if (forgot) QuietLink("Back to sign in", enabled = !busy, onClick = toSignIn)
                else if (canForget) QuietLink("Forgot password?", enabled = !busy) { forgot = true; vm.onAction(AuthAction.Clear) }
                Gap()
                onCancel?.let { QuietLink("Back to the till", enabled = !busy, onClick = it) }
            }
        }
        if (!forgot) {
            T(
                "Your password goes to EasyPay's sign-in service and is not kept on this tablet.",
                12.sp, 500, V.Text3, Modifier.fillMaxWidth(), lines = 2, align = TextAlign.Center, height = 17.sp,
            )
        }
        // The other thing a tablet can be: a screen in the kitchen that shows
        // the orders the tills send it. It needs no login.
        if (!forgot && !reauth && onKitchen != null) {
            Column(
                Modifier.fillMaxWidth().padding(top = 6.dp).clip(RoundedCornerShape(12.dp)).background(V.Well).padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp), horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                QuietLink("Set up as a kitchen screen", enabled = !busy, onClick = onKitchen)
                T("For a tablet in the kitchen: it shows the orders as they are sent. It needs no login.", 12.sp, 500, V.Text3, lines = 2, align = TextAlign.Center, height = 17.sp)
            }
        }
    }
}

// The eye on the password box, drawn like the till's other icons (24 units, a line).
private const val EYE = "M2.5 12a11 11 0 0 1 19 0a11 11 0 0 1-19 0M12 9.2a2.8 2.8 0 1 0 0 5.6a2.8 2.8 0 1 0 0-5.6"
private const val EYE_OFF = "$EYE M4 4l16 16"

@Composable
fun StoreDeviceScreen(vm: StoreDeviceViewModel = hiltViewModel(), onReady: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(state) { if (state is StoreDeviceUiState.Ready) onReady() }
    var name by remember { mutableStateOf("Terminal 01") }
    var code by remember { mutableStateOf("T1") }
    SetupCard {
        when (val s = state) {
            StoreDeviceUiState.Loading, StoreDeviceUiState.Busy, StoreDeviceUiState.Ready -> {
                Heading("Name this till", if (s == StoreDeviceUiState.Loading) "Looking up the stores of this business." else "Setting the till up. This takes a moment.")
                Box(Modifier.fillMaxWidth().height(96.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(28.dp), color = V.Cyan, strokeWidth = 2.5.dp)
                }
            }
            is StoreDeviceUiState.Error -> {
                Heading("Name this till", "The stores of this business could not be read.")
                Problem(s.message)
                MainKey("Try again", ready = true, busy = false) { vm.refresh() }
            }
            is StoreDeviceUiState.Pick -> {
                Heading("Name this till", "Its code goes into every receipt number, so each till of a store needs its own.")
                s.error?.let { Problem(it) }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    SetupField("Till name", name, { name = it }, "Terminal 01", Modifier.weight(1.6f), ime = ImeAction.Next)
                    SetupField("Till code", code, { code = it }, "T1", Modifier.weight(1f), ime = ImeAction.Done)
                }
                T(if (s.stores.size == 1) "Its store" else "Which store is it in?", 13.sp, 600, V.Text2, Modifier.padding(top = 4.dp))
                val ready = name.isNotBlank() && code.isNotBlank()
                s.stores.forEach { st ->
                    MainKey(
                        if (!ready) "Give the till a name and a code" else if (s.stores.size == 1) "Set up in ${st.name} (${st.code})" else "${st.name} (${st.code})",
                        ready = ready, busy = false,
                    ) { vm.onAction(StoreDeviceAction.Register(st.id, name, code)) }
                }
            }
        }
    }
}
