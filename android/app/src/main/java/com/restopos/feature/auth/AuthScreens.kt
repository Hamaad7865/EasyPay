package com.restopos.feature.auth

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restopos.app.BuildConfig
import com.restopos.core.ui.Gap
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.Wordmark
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
                s.notice?.let { T(it, 14.sp, 600, V.BlueText, lines = 3, height = 20.sp) }
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
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                    QuietLink("Seed Le Flamboyant demo menu", enabled = true) { vm.onAction(StoreDeviceAction.SeedDemo) }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- the card

// One card in the middle of the screen, on the till's own ground. With the
// keyboard up it scrolls, and the box being typed in stays in view.
@Composable
private fun SetupCard(content: @Composable ColumnScope.() -> Unit) {
    Box(Modifier.fillMaxSize().background(V.Bg).systemBarsPadding().imePadding()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier.widthIn(max = 520.dp).fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(V.Panel).border(1.dp, V.Stroke, RoundedCornerShape(22.dp))
                    .padding(start = 30.dp, end = 30.dp, top = 28.dp, bottom = 26.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Wordmark()
                content()
            }
            T("EasyPay ${BuildConfig.VERSION_NAME}", 12.sp, 500, V.Text3)
        }
    }
}

@Composable
private fun Heading(title: String, sub: String) {
    Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        T(title, 24.sp, 800, V.Text, spacing = (-0.5).sp)
        T(sub, 14.sp, 500, V.Text2, lines = 3, height = 20.sp)
    }
}

// what went wrong, on a wash of its own colour
@Composable
private fun Problem(text: String) {
    T(
        text, 14.sp, 600, V.RedText,
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.RedWash).padding(horizontal = 14.dp, vertical = 11.dp),
        lines = 4, height = 20.sp,
    )
}

// A box to type in, with its name above it. The edge lights up in the logo's
// green while it is being typed in.
@Composable
private fun SetupField(
    label: String, value: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier, enabled: Boolean = true,
    keyboard: KeyboardType = KeyboardType.Text, ime: ImeAction = ImeAction.Done, onIme: () -> Unit = {}, masked: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
) {
    var focused by remember { mutableStateOf(false) }
    val edge by animateColorAsState(if (focused) V.Cyan else V.Stroke, label = "edge")
    Column(modifier, verticalArrangement = Arrangement.spacedBy(7.dp)) {
        T(label, 13.sp, 600, V.Text2)
        Row(
            Modifier.fillMaxWidth().height(54.dp).clip(RoundedCornerShape(12.dp)).background(V.Well).border(if (focused) 1.5.dp else 1.dp, edge, RoundedCornerShape(12.dp))
                .padding(start = 16.dp, end = if (trailing != null) 5.dp else 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) T(placeholder, 16.sp, 400, V.Off)
                BasicTextField(
                    value, onChange, Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }, enabled = enabled, singleLine = true,
                    textStyle = TextStyle(color = V.Text, fontSize = 16.sp, fontWeight = FontWeight.Medium),
                    cursorBrush = SolidColor(V.Cyan),
                    visualTransformation = if (masked) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(keyboardType = keyboard, imeAction = ime),
                    keyboardActions = KeyboardActions(onDone = { onIme() }),
                )
            }
            if (trailing != null) { Spacer(Modifier.size(4.dp)); trailing() }
        }
    }
}

// The card's one main key. Until it can be pressed it says what is missing,
// in place of a greyed-out word; while the till is at work it turns.
@Composable
private fun MainKey(label: String, ready: Boolean, busy: Boolean, onClick: () -> Unit) {
    val on = ready && !busy
    Box(
        Modifier.fillMaxWidth().height(60.dp).then(if (on) Modifier.press(0.98f, onClick) else Modifier).clip(RoundedCornerShape(14.dp))
            .background(if (ready) V.Blue else V.Key),
        contentAlignment = Alignment.Center,
    ) {
        if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp)
        else T(label, if (ready) 17.sp else 15.sp, if (ready) 800 else 600, if (ready) Color.White else V.Text3)
    }
}

@Composable
private fun QuietLink(label: String, enabled: Boolean, onClick: () -> Unit) {
    T(label, 14.sp, 600, if (enabled) V.BlueText else V.Off, Modifier.then(if (enabled) Modifier.press(0.97f, onClick) else Modifier).padding(vertical = 8.dp))
}
