package com.restopos.feature.auth

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Uuid7
import com.restopos.core.network.ApiClient
import com.restopos.core.network.ApiError
import com.restopos.app.BuildConfig
import com.restopos.core.network.AuthClient
import com.restopos.core.network.AuthRefused
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
import java.io.IOException
import javax.inject.Inject

// --- Auth (spec 7.1 steps 1-2; PIN screen is Phase 4) ---
// Every outcome is a state: the screen navigates on SignedIn, it never reads a
// plain field that Compose cannot observe.
sealed interface AuthUiState {
    data object Form : AuthUiState
    data object Busy : AuthUiState
    data object SignedIn : AuthUiState
    data class Error(val message: String) : AuthUiState
    // the link for choosing a new password was asked for
    data class LinkSent(val email: String) : AuthUiState
    // the tablet was set up with its code: it is a till, with no login
    data object CodeTaken : AuthUiState
}

sealed interface AuthAction {
    data class SignIn(val email: String, val password: String) : AuthAction
    data class Forgot(val email: String) : AuthAction
    // back to the empty form, with whatever was said cleared
    data object Clear : AuthAction
}

// What the screen says when signing in, or asking for a reset link, fails.
// The service's own words are kept only where nothing here covers the case.
internal fun authProblem(e: Throwable?, fallback: String): String = when {
    e is AuthRefused && e.status == 429 -> "Too many tries. Wait a minute, then try again."
    e is AuthRefused && e.status == 401 -> "That email and password do not match. Check both and try again."
    e is IOException -> "Cannot reach EasyPay. Check the tablet's internet connection and try again."
    else -> e?.message?.takeIf { it.isNotBlank() } ?: fallback
}

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val auth: AuthClient,
    private val api: ApiClient,
    private val session: SessionStore,
    private val backups: com.restopos.core.data.Backup,
    @ApplicationContext private val appContext: Context,
) : ViewModel() {
    // ---- a tablet filled from a backup (core/data/Backup) ----
    // The backup that was read and waits for a yes, and what was said of one that could not be.
    val backup = MutableStateFlow<com.restopos.core.data.BackupFile.Note?>(null)
    val backupSaid = MutableStateFlow<String?>(null)
    fun readBackup(from: android.net.Uri) = viewModelScope.launch {
        backupSaid.value = "Reading the backup…"
        backups.read(from).fold({ backup.value = it; backupSaid.value = null }, { backupSaid.value = it.message ?: "That file could not be read." })
    }
    // A tablet with no screen to pick a file on: the newest backup in the
    // till's own folder is the one read, and with none there the tablet says
    // where to put it.
    fun readOwnBackup() = viewModelScope.launch {
        val found = backups.newestOwn()
        if (found != null) readBackup(found)
        else backupSaid.value = "This tablet has no screen to pick a file on. Copy the backup file into " + backups.ownPath() +
            " on this tablet, from a computer on its cable, then tap Restore from a backup again."
    }
    fun leaveBackup() { backup.value = null; backupSaid.value = null; restoring.value = false; backups.forget() }
    // A backup is a till, and a tablet is that till only with the code
    // EasyPay made for its replacement: without one, a backup file would set
    // up as many tablets as anyone liked. The code is checked once, online;
    // then the app starts again with what the backup holds, and with the
    // till's key, which no backup carries.
    val restoring = MutableStateFlow(false)
    fun useBackup(code: String) = viewModelScope.launch {
        val note = backup.value ?: return@launch
        if (restoring.value) return@launch
        if (!TILL_ID.matches(note.device)) {
            backupSaid.value = "This backup does not say which till it is of, so it cannot fill a new tablet. Contact EasyPay."
            return@launch
        }
        restoring.value = true
        backupSaid.value = null
        runCatching { api.redeem(com.restopos.core.data.CodeForm.plain(code), note.device, BuildConfig.VERSION_NAME, mustBe = note.device) }
            .onSuccess { backups.restart() }
            .onFailure { backupSaid.value = codeProblem(it); restoring.value = false }
    }

    // ---- a tablet set up with its code (the till service's /devices/redeem) ----
    // One code sets up one tablet, with no login. What the tablet is then is
    // what a login's set-up leaves it: the business, the store and the till,
    // and the till's key. Its first pull follows, as after "Name this till".
    fun useCode(code: String) = viewModelScope.launch {
        if (_state.value == AuthUiState.Busy) return@launch
        _state.value = AuthUiState.Busy
        // A tablet that is a till already and is asked to sign in: its key was
        // ended, or lost. One set up with a code has no login to sign in with.
        // The code it was set up with, or the one made since for its
        // replacement, gives it a key again. Only a code of this very till will
        // do (mustBe): any other would make it another till over its own sales.
        val till = session.deviceId()
        if (session.tenantId() != null && till != null) {
            runCatching { api.redeem(com.restopos.core.data.CodeForm.plain(code), till, BuildConfig.VERSION_NAME, mustBe = till) }
                .onSuccess {
                    session.setNeedsSignIn(false)
                    pushNow(appContext)
                    SyncScheduler.pullNow(appContext)
                    _state.value = AuthUiState.SignedIn
                }
                .onFailure { _state.value = AuthUiState.Error(codeProblem(it)) }
            return@launch
        }
        runCatching {
            val out = api.redeem(com.restopos.core.data.CodeForm.plain(code), session.deviceId() ?: com.restopos.core.common.Uuid7.next(), BuildConfig.VERSION_NAME)
            session.save(out.tenantId, out.storeId, out.deviceId)
            // what the tablet does next waits for a whole pull after this moment (SetupSteps.after)
            session.setRegisteredAt(System.currentTimeMillis())
            if (out.business.isNotBlank()) session.setBusinessName(out.business)
        }.onSuccess {
            SyncScheduler.pullNow(appContext)
            _state.value = AuthUiState.CodeTaken
        }.onFailure { _state.value = AuthUiState.Error(codeProblem(it)) }
    }

    private val TILL_ID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    // What is said of a code that did not work: the server's own sentence
    // when it refused it, and plainly that the internet is needed otherwise.
    private fun codeProblem(e: Throwable): String = when (e) {
        is ApiError -> e.message ?: "That code did not work."
        is java.io.IOException -> "The code could not be checked: the tablet needs the internet for a moment. Connect it and try again."
        else -> e.message?.takeIf { it.isNotBlank() && it.length < 160 } ?: "The code could not be checked. Try again in a moment."
    }

    private val _state = MutableStateFlow<AuthUiState>(AuthUiState.Form)
    val state: StateFlow<AuthUiState> = _state

    // The page a reset link opens is the back office's (backOfficeUrl in
    // local.properties). Until the back office has an address there is nowhere
    // for the link to land, and the screen does not offer it.
    private val resetPage = BuildConfig.BACK_OFFICE_URL.trimEnd('/').takeIf { it.isNotBlank() }?.let { "$it/reset-password" }
    val canReset: Boolean get() = resetPage != null

    fun onAction(a: AuthAction) = viewModelScope.launch {
        if (a is AuthAction.Clear) {
            _state.value = AuthUiState.Form
            return@launch
        }
        _state.value = AuthUiState.Busy
        if (a is AuthAction.Forgot) {
            val email = a.email.trim()
            val page = resetPage
            _state.value = if (page == null) AuthUiState.Form else auth.requestPasswordReset(email, page).fold(
                onSuccess = { AuthUiState.LinkSent(email) },
                onFailure = { AuthUiState.Error(authProblem(it, "The link could not be sent. Try again in a minute.")) },
            )
            return@launch
        }
        a as AuthAction.SignIn
        val r = auth.signIn(a.email.trim(), a.password)
        if (r.isFailure) {
            _state.value = AuthUiState.Error(authProblem(r.exceptionOrNull(), "Sign-in failed"))
            return@launch
        }
        // Signing in again on a tablet that is already set up (the session
        // expired): the sales waiting on it belong to one restaurant, so only a
        // login of that restaurant may resume. Then everything queued goes up.
        val tenant = session.tenantId()
        if (tenant != null) {
            val me = runCatching { api.me() }.getOrElse {
                if (it is ApiError && it.status == 403) {
                    auth.signOut()
                    _state.value = AuthUiState.Error("That login is not linked to a business, or it was switched off. Use another login of this business.")
                } else {
                    _state.value = AuthUiState.Error(it.message ?: "Could not check this login")
                }
                return@launch
            }
            if (me.tenantId != tenant) {
                auth.signOut()
                _state.value = AuthUiState.Error("That login belongs to another business. Use a login of the business this tablet is set up for.")
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
    data class Pick(val stores: List<StoreDto>, val error: String? = null) : StoreDeviceUiState
    data object Busy : StoreDeviceUiState
    data object Ready : StoreDeviceUiState
    data class Error(val message: String) : StoreDeviceUiState
}

sealed interface StoreDeviceAction {
    data class Register(val storeId: String, val name: String, val code: String) : StoreDeviceAction
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
                    // what the tablet does next waits for a whole pull after this moment (SetupSteps.after)
                    session.setRegisteredAt(System.currentTimeMillis())
                    me.tenants.firstOrNull { it.id == me.tenantId }?.let { session.setBusinessName(it.name) }
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
        }
    }
}
