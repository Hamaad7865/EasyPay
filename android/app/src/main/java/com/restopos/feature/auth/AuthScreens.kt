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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun AuthScreen(vm: AuthViewModel = hiltViewModel(), onSignedIn: () -> Unit) {
    val state by vm.state.collectAsState()
    if (vm.signedIn) { onSignedIn(); return }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("RestoPOS", style = MaterialTheme.typography.headlineLarge)
        Text("Owner sign-in. Staff PIN arrives in Phase 4.")
        OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth(), label = { Text("Email") })
        OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text("Password") }, visualTransformation = PasswordVisualTransformation())
        if (state is AuthUiState.Error) Text((state as AuthUiState.Error).message, color = MaterialTheme.colorScheme.error)
        Button(onClick = { vm.onAction(AuthAction.SignIn(email, password)) }, enabled = state != AuthUiState.Busy, modifier = Modifier.fillMaxWidth()) {
            if (state == AuthUiState.Busy) CircularProgressIndicator() else Text("Sign in")
        }
    }
}

@Composable
fun StoreDeviceScreen(vm: StoreDeviceViewModel = hiltViewModel(), onReady: () -> Unit) {
    val state by vm.state.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current
    if (vm.ready) { onReady(); return }
    var name by remember { mutableStateOf("Terminal 01") }
    var code by remember { mutableStateOf("T1") }
    var msg by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Choose store", style = MaterialTheme.typography.headlineMedium)
        when (val s = state) {
            StoreDeviceUiState.Loading, StoreDeviceUiState.Busy -> CircularProgressIndicator()
            is StoreDeviceUiState.Error -> { Text(s.message, color = MaterialTheme.colorScheme.error); Button(onClick = { vm.refresh() }) { Text("Retry") } }
            is StoreDeviceUiState.Pick -> {
                s.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                s.stores.forEach { st ->
                    Button(onClick = { vm.onAction(StoreDeviceAction.Register(st.id, name, code), context) }) {
                        Text("${st.name} (${st.code})")
                    }
                }
                OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Device name") })
                OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth(), label = { Text("Device code") })
                TextButton(onClick = { vm.onAction(StoreDeviceAction.SeedDemo { m -> msg = m; vm.refresh() }, context) }) {
                    Text("Seed Le Flamboyant demo menu")
                }
                msg?.let { Text(it) }
            }
        }
    }
}
