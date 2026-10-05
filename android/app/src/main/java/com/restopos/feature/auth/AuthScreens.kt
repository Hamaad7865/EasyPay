package com.restopos.feature.auth

import com.restopos.core.ui.Logo
import com.restopos.core.ui.VI
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle

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
    // the "forgot password" step: the same screen asking only for the email
    var forgot by remember { mutableStateOf(false) }
    val busy = state == AuthUiState.Busy || state == AuthUiState.SignedIn
    val problem = (state as? AuthUiState.Error)?.message
    val toSignIn: () -> Unit = { forgot = false; vm.onAction(AuthAction.Clear) }
    val signIn: () -> Unit = { if (!busy) vm.onAction(AuthAction.SignIn(email, password)) }
    val sendLink: () -> Unit = { if (!busy) vm.onAction(AuthAction.Forgot(email)) }
    // It scrolls and keeps clear of the keyboard, so what the screen says
    // about a wrong password is never under it.
    Column(
        Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Logo(Modifier.width(220.dp))
        val sent = state as? AuthUiState.LinkSent
        if (sent != null) {
            Text("If ${sent.email} is an EasyPay login, a link to choose a new password is on its way to it.")
            Text("Open the link on a phone or a computer, choose the password, then sign in here with it. Nothing after a few minutes? Look in the spam folder.")
            Button(onClick = toSignIn, modifier = Modifier.fillMaxWidth()) { Text("Back to sign in") }
        } else {
            Text(
                if (forgot) "Enter the email you sign in with. We will send it a link to choose a new password."
                else if (reauth) "Sign in again to sync. Everything sold on this tablet is saved and will go up once you are signed in."
                else "Sign in with the login EasyPay gave you.",
            )
            OutlinedTextField(
                email, { email = it }, Modifier.fillMaxWidth(), label = { Text("Email") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = if (forgot) ImeAction.Done else ImeAction.Next),
                keyboardActions = KeyboardActions(onDone = { sendLink() }),
            )
            if (!forgot) {
                OutlinedTextField(
                    password, { password = it }, Modifier.fillMaxWidth(), label = { Text("Password") }, singleLine = true,
                    visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { signIn() }),
                    // the eye: show what was typed, or hide it again
                    trailingIcon = {
                        IconButton(onClick = { shown = !shown }) {
                            Icon(VI.of(if (shown) EYE_OFF else EYE, 2f), contentDescription = if (shown) "Hide password" else "Show password")
                        }
                    },
                )
            }
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = if (forgot) sendLink else signIn, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                if (busy) CircularProgressIndicator() else Text(if (forgot) "Send the link" else "Sign in")
            }
            if (forgot) {
                TextButton(onClick = toSignIn, enabled = !busy) { Text("Back to sign in") }
            } else if (vm.canReset) {
                TextButton(onClick = { forgot = true; vm.onAction(AuthAction.Clear) }, enabled = !busy) { Text("Forgot password?") }
            }
            onCancel?.let { TextButton(onClick = it, enabled = !busy) { Text("Back to the till") } }
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
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Choose store", style = MaterialTheme.typography.headlineMedium)
        when (val s = state) {
            StoreDeviceUiState.Loading, StoreDeviceUiState.Busy, StoreDeviceUiState.Ready -> CircularProgressIndicator()
            is StoreDeviceUiState.Error -> {
                Text(s.message, color = MaterialTheme.colorScheme.error)
                Button(onClick = { vm.refresh() }) { Text("Retry") }
            }
            is StoreDeviceUiState.Pick -> {
                s.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                s.notice?.let { Text(it) }
                OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Device name") }, singleLine = true)
                OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth(), label = { Text("Device code (unique in the store)") }, singleLine = true)
                s.stores.forEach { st ->
                    Button(onClick = { vm.onAction(StoreDeviceAction.Register(st.id, name, code)) }) {
                        Text("${st.name} (${st.code})")
                    }
                }
                TextButton(onClick = { vm.onAction(StoreDeviceAction.SeedDemo) }) {
                    Text("Seed Le Flamboyant demo menu")
                }
            }
        }
    }
}
