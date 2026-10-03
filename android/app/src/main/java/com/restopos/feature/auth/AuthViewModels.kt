package com.restopos.feature.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Uuid7
import com.restopos.core.network.ApiClient
import com.restopos.core.network.AuthClient
import com.restopos.core.network.dto.RegisterDeviceRequest
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.SyncScheduler
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

// --- Auth (spec 7.1 steps 1-2; PIN screen is Phase 4) ---
sealed interface AuthUiState {
    data object Form : AuthUiState
    data object Busy : AuthUiState
    data class Error(val message: String) : AuthUiState
}

sealed interface AuthAction {
    data class SignIn(val email: String, val password: String) : AuthAction
    data class SignUp(val name: String, val email: String, val password: String) : AuthAction
}

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val auth: AuthClient,
    private val api: ApiClient,
) : ViewModel() {
    private val _state = MutableStateFlow<AuthUiState>(AuthUiState.Form)
    val state: StateFlow<AuthUiState> = _state
    var signedIn = false
        private set

    fun onAction(a: AuthAction) = viewModelScope.launch {
        _state.value = AuthUiState.Busy
        val r = when (a) {
            is AuthAction.SignIn -> auth.signIn(a.email.trim(), a.password)
            is AuthAction.SignUp -> auth.signUp(a.name.trim(), a.email.trim(), a.password)
        }
        r.onSuccess { signedIn = true; _state.value = AuthUiState.Form }
            .onFailure { _state.value = AuthUiState.Error(it.message ?: "Sign-in failed") }
    }
}

// --- Store + device selection (spec 7.1 step 2; Phase 1 exit needs this) ---
sealed interface StoreDeviceUiState {
    data object Loading : StoreDeviceUiState
    data class Pick(val stores: List<com.restopos.core.network.dto.StoreDto>, val error: String? = null) : StoreDeviceUiState
    data object Busy : StoreDeviceUiState
    data class Error(val message: String) : StoreDeviceUiState
}

sealed interface StoreDeviceAction {
    data class Register(val storeId: String, val name: String, val code: String) : StoreDeviceAction
    data class SeedDemo(val onDone: (String) -> Unit) : StoreDeviceAction
}

@HiltViewModel
class StoreDeviceViewModel @Inject constructor(
    private val api: ApiClient,
    private val session: SessionStore,
) : ViewModel() {
    private val _state = MutableStateFlow<StoreDeviceUiState>(StoreDeviceUiState.Loading)
    val state: StateFlow<StoreDeviceUiState> = _state
    var ready = false
        private set

    init { refresh() }

    fun refresh() = viewModelScope.launch {
        _state.value = StoreDeviceUiState.Loading
        runCatching { api.me() }
            .onSuccess { _state.value = StoreDeviceUiState.Pick(it.stores) }
            .onFailure { _state.value = StoreDeviceUiState.Error(it.message ?: "Load failed") }
    }

    fun onAction(a: StoreDeviceAction, context: android.content.Context) = viewModelScope.launch {
        when (a) {
            is StoreDeviceAction.Register -> {
                _state.value = StoreDeviceUiState.Busy
                // Client-minted device id (spec 15); reinstall re-sends it via
                // DataStore when present — here a fresh id per registration call.
                val deviceId = session.deviceId() ?: Uuid7.next()
                runCatching {
                    api.registerDevice(RegisterDeviceRequest(a.storeId, deviceId, a.name, a.code.uppercase()))
                }.onSuccess { res ->
                    val me = api.me()
                    session.save(me.tenantId, a.storeId, res.deviceId)
                    SyncScheduler.pullNow(context)
                    ready = true
                }.onFailure { _state.value = StoreDeviceUiState.Error(it.message ?: "Register failed") }
            }
            is StoreDeviceAction.SeedDemo -> {
                runCatching { api.seedDemo() }
                    .onSuccess { a.onDone("Demo menu seeded — pulling") }
                    .onFailure { a.onDone(it.message ?: "Seed failed (Manager only)") }
            }
        }
    }
}
