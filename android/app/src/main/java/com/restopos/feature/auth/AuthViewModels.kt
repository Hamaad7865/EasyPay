package com.restopos.feature.auth

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Uuid7
import com.restopos.core.network.ApiClient
import com.restopos.core.network.ApiError
import com.restopos.core.network.AuthClient
import com.restopos.core.network.dto.RegisterDeviceRequest
import com.restopos.core.network.dto.StoreDto
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.SyncScheduler
import com.restopos.core.sync.pushNow
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

// --- Auth (spec 7.1 steps 1-2; PIN screen is Phase 4) ---
// Every outcome is a state: the screen navigates on SignedIn, it never reads a
// plain field that Compose cannot observe.
sealed interface AuthUiState {
    data object Form : AuthUiState
    data object Busy : AuthUiState
    data object SignedIn : AuthUiState
    data class Error(val message: String) : AuthUiState
}

sealed interface AuthAction {
    data class SignIn(val email: String, val password: String) : AuthAction
}

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val auth: AuthClient,
    private val api: ApiClient,
    private val session: SessionStore,
    @ApplicationContext private val appContext: Context,
) : ViewModel() {
    private val _state = MutableStateFlow<AuthUiState>(AuthUiState.Form)
    val state: StateFlow<AuthUiState> = _state

    fun onAction(a: AuthAction) = viewModelScope.launch {
        _state.value = AuthUiState.Busy
        val r = when (a) {
            is AuthAction.SignIn -> auth.signIn(a.email.trim(), a.password)
        }
        if (r.isFailure) {
            _state.value = AuthUiState.Error(r.exceptionOrNull()?.message ?: "Sign-in failed")
            return@launch
        }
        // Signing in again on a tablet that is already set up (the session
        // expired): the sales waiting on it belong to one restaurant, so only a
        // login of that restaurant may resume. Then everything queued goes up.
        val tenant = session.tenantId()
        if (tenant != null) {
            val me = runCatching { api.me() }.getOrElse {
                _state.value = AuthUiState.Error(it.message ?: "Could not check this login")
                return@launch
            }
            if (me.tenantId != tenant) {
                auth.signOut()
                _state.value = AuthUiState.Error("That login belongs to another restaurant. Use a login of the restaurant this tablet is set up for.")
                return@launch
            }
            session.setNeedsSignIn(false)
            pushNow(appContext)
            SyncScheduler.pullNow(appContext)
        }
        _state.value = AuthUiState.SignedIn
    }
}

// --- Store + device selection (spec 7.1 step 2; Phase 1 exit needs this) ---
sealed interface StoreDeviceUiState {
    data object Loading : StoreDeviceUiState
    data class Pick(val stores: List<StoreDto>, val error: String? = null, val notice: String? = null) : StoreDeviceUiState
    data object Busy : StoreDeviceUiState
    data object Ready : StoreDeviceUiState
    data class Error(val message: String) : StoreDeviceUiState
}

sealed interface StoreDeviceAction {
    data class Register(val storeId: String, val name: String, val code: String) : StoreDeviceAction
    data object SeedDemo : StoreDeviceAction
}

@HiltViewModel
class StoreDeviceViewModel @Inject constructor(
    private val api: ApiClient,
    private val session: SessionStore,
    @ApplicationContext private val appContext: Context,
) : ViewModel() {
    private val _state = MutableStateFlow<StoreDeviceUiState>(StoreDeviceUiState.Loading)
    val state: StateFlow<StoreDeviceUiState> = _state
    private var stores: List<StoreDto> = emptyList()

    init { refresh() }

    fun refresh() = viewModelScope.launch {
        _state.value = StoreDeviceUiState.Loading
        runCatching { api.me() }
            .onSuccess { stores = it.stores; _state.value = StoreDeviceUiState.Pick(stores) }
            .onFailure { _state.value = StoreDeviceUiState.Error(it.message ?: "Could not load stores") }
    }

    fun onAction(a: StoreDeviceAction) = viewModelScope.launch {
        when (a) {
            is StoreDeviceAction.Register -> {
                _state.value = StoreDeviceUiState.Busy
                // Client-minted device id (spec 15): reused if this tablet was
                // registered before, so a reinstall resumes its receipt sequence.
                val deviceId = session.deviceId() ?: Uuid7.next()
                runCatching {
                    val res = api.registerDevice(RegisterDeviceRequest(a.storeId, deviceId, a.name.trim(), a.code.trim().uppercase()))
                    val me = api.me()
                    session.save(me.tenantId, a.storeId, res.deviceId)
                }.onSuccess {
                    SyncScheduler.pullNow(appContext)
                    _state.value = StoreDeviceUiState.Ready
                }.onFailure {
                    val message = if (it is ApiError && it.status == 409) {
                        "Device code ${a.code.trim().uppercase()} is already used in this store. Pick another."
                    } else {
                        it.message ?: "Could not register this device"
                    }
                    _state.value = StoreDeviceUiState.Pick(stores, error = message)
                }
            }
            StoreDeviceAction.SeedDemo -> {
                runCatching { api.seedDemo() }
                    .onSuccess { _state.value = StoreDeviceUiState.Pick(stores, notice = "Demo menu added") }
                    .onFailure { _state.value = StoreDeviceUiState.Pick(stores, error = it.message ?: "Could not add the demo menu") }
            }
        }
    }
}
