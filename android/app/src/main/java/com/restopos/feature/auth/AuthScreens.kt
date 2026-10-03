package com.restopos.feature.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
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
    val busy = state == AuthUiState.Busy || state == AuthUiState.SignedIn
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("RestoPOS", style = MaterialTheme.typography.headlineLarge)
        Text(
            if (reauth) "Sign in again to sync. Everything sold on this tablet is saved and will go up once you are signed in."
            else "Sign in with the login RestoPOS gave you. Staff PIN arrives in Phase 4.",
        )
        OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth(), label = { Text("Email") }, singleLine = true)
        OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
        (state as? AuthUiState.Error)?.let { Text(it.message, color = MaterialTheme.colorScheme.error) }
        Button(onClick = { vm.onAction(AuthAction.SignIn(email, password)) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            if (busy) CircularProgressIndicator() else Text("Sign in")
        }
        onCancel?.let { TextButton(onClick = it, enabled = !busy) { Text("Back to the till") } }
    }
}

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
