package com.restopos.feature.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
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
import com.restopos.core.data.CodeForm
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
    // The tablet was set up with a code, and is a till: offered where the
    // kitchen screen is, when a tablet is first set up.
    onCode: (() -> Unit)? = null,
    onSignedIn: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    // Navigation is a side effect of the state, run once when it becomes SignedIn.
    LaunchedEffect(state) {
        if (state is AuthUiState.SignedIn) onSignedIn()
        if (state is AuthUiState.CodeTaken) onCode?.invoke()
    }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var shown by remember { mutableStateOf(false) }
    // the "forgot password" step: the same card asking only for the email
    var forgot by remember { mutableStateOf(false) }
    // the same card asking only for the code EasyPay gave for this tablet
    var byCode by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    val busy = state == AuthUiState.Busy || state == AuthUiState.SignedIn || state == AuthUiState.CodeTaken
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
        if (byCode) {
            val useCode: () -> Unit = {
                if (!busy && CodeForm.ready(code)) {
                    keyboard?.hide()
                    focus.clearFocus()
                    vm.useCode(code)
                }
            }
            if (reauth) Heading("Use this tablet's code", "Type the code this tablet was set up with, or the one EasyPay gave for it since. It needs the internet for a moment.")
            else Heading("Set up with a code", "Type the code EasyPay gave for this tablet. It needs the internet for a moment, and not again after.")
            problem?.let { Problem(it) }
            SetupField(
                "Code", code, { code = it.take(24) }, "XXXX-XXXX-XXXX", enabled = !busy,
                keyboard = KeyboardType.Ascii, ime = ImeAction.Done, onIme = useCode, caps = true,
            )
            // how it reads, to hold against the paper it was written on
            if (code.isNotBlank()) T(CodeForm.typed(code), 22.sp, 800, if (CodeForm.ready(code)) V.Text else V.Text2, Modifier.fillMaxWidth(), align = TextAlign.Center)
            MainKey(if (!CodeForm.ready(code)) "Enter the code" else if (reauth) "Use this code" else "Set up this tablet", ready = CodeForm.ready(code), busy = busy, onClick = useCode)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                QuietLink("Back to sign in", enabled = !busy) { byCode = false; vm.onAction(AuthAction.Clear) }
                Gap()
                onCancel?.let { QuietLink("Back to the till", enabled = !busy, onClick = it) }
            }
            T(
                "One code sets up one tablet. A tablet that replaces another needs a code of its own from EasyPay.",
                12.sp, 500, V.Text3, Modifier.fillMaxWidth(), lines = 2, align = TextAlign.Center, height = 17.sp,
            )
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
        // A tablet set up with a code has no login to sign in with again: its
        // code, or the one EasyPay made for it since, does what a sign-in does.
        if (!forgot && reauth) {
            Column(
                Modifier.fillMaxWidth().padding(top = 6.dp).clip(RoundedCornerShape(12.dp)).background(V.Well).padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp), horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                QuietLink("Use a code from EasyPay", enabled = !busy) { byCode = true; vm.onAction(AuthAction.Clear) }
                T("For a tablet that was set up with a code: that code, or the one EasyPay gave for it since. It needs no login.", 12.sp, 500, V.Text3, lines = 3, align = TextAlign.Center, height = 17.sp)
            }
        }
        // The other thing a tablet can be: a screen in the kitchen that shows
        // the orders the tills send it. It needs no login.
        if (!forgot && !reauth && onKitchen != null) {
            // Beside it, the other way to make this tablet a till: the code
            // EasyPay made for it. A business that runs on its tablet has no
            // other way, and it needs no login either.
            Row(Modifier.fillMaxWidth().padding(top = 6.dp).height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (onCode != null) {
                    Column(
                        Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(12.dp)).background(V.Well).padding(horizontal = 12.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp), horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        QuietLink("Set up with a code", enabled = !busy) { byCode = true; vm.onAction(AuthAction.Clear) }
                        T("For a business that runs on its tablet: the code EasyPay gave for this one. It needs no login.", 12.sp, 500, V.Text3, lines = 4, align = TextAlign.Center, height = 17.sp)
                    }
                }
                Column(
                    Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(12.dp)).background(V.Well).padding(horizontal = 12.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp), horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    QuietLink("Set up as a kitchen screen", enabled = !busy, onClick = onKitchen)
                    T("For a tablet in the kitchen: it shows the orders as they are sent. It needs no login.", 12.sp, 500, V.Text3, lines = 4, align = TextAlign.Center, height = 17.sp)
                }
            }
            // A tablet that replaces one that broke: filled from the backup its owner saved. Offered only
            // here, where the tablet holds nothing yet, so a backup never writes over a tablet's sales.
            val waiting by vm.backup.collectAsStateWithLifecycle()
            val said by vm.backupSaid.collectAsStateWithLifecycle()
            val pick = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) vm.readBackup(uri) }
            Column(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.Well).padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp), horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val found = waiting
                if (found == null) {
                    QuietLink("Restore from a backup", enabled = !busy) { pick.launch(arrayOf("*/*")) }
                    T(said ?: "For a tablet that replaces another: pick the backup file its owner saved, then type the code EasyPay gave for the replacement.", 12.sp, 500, if (said != null) V.AmberText else V.Text3, lines = 3, align = TextAlign.Center, height = 17.sp)
                } else {
                    // A backup is a till, and this tablet is that till only with the code made for its
                    // replacement: checked once, online, before anything is put in place.
                    val restoring by vm.restoring.collectAsStateWithLifecycle()
                    var replace by remember(found) { mutableStateOf("") }
                    T("Backup of " + found.business.ifBlank { "a till" } + ", saved " + java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(found.madeAt)), 14.sp, 700, lines = 2, align = TextAlign.Center)
                    T("This tablet becomes that till, with everything the backup holds. Sales made on the old tablet after the backup was saved are not in it.", 12.sp, 500, V.Text3, lines = 3, align = TextAlign.Center, height = 17.sp)
                    said?.let { T(it, 12.sp, 600, V.AmberText, lines = 4, align = TextAlign.Center, height = 17.sp) }
                    SetupField(
                        "The code for the replacement tablet", replace, { replace = it.take(24) }, "XXXX-XXXX-XXXX", enabled = !restoring,
                        keyboard = KeyboardType.Ascii, ime = ImeAction.Done, onIme = { if (CodeForm.ready(replace)) vm.useBackup(replace) }, caps = true,
                    )
                    if (replace.isNotBlank()) T(CodeForm.typed(replace), 18.sp, 800, if (CodeForm.ready(replace)) V.Text else V.Text2, align = TextAlign.Center)
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        QuietLink("Not this one", enabled = !restoring) { vm.leaveBackup() }
                        if (restoring) CircularProgressIndicator(Modifier.size(18.dp), color = V.Cyan, strokeWidth = 2.dp)
                        else QuietLink("Restore it", enabled = CodeForm.ready(replace)) { vm.useBackup(replace) }
                    }
                }
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
