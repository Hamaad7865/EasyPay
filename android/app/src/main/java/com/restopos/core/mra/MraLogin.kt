package com.restopos.core.mra

import android.content.Context
import com.restopos.core.common.SecretStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.Base64
import javax.inject.Inject
import javax.inject.Singleton

// The till's MRA login, typed on the till by a manager (the owner's decision:
// each till signs in to the MRA itself), and the token and key the MRA gives
// it: all in the till's own encrypted store (Android Keystore, SecretStore),
// in a file of their own. None of it is ever sent to EasyPay's server, put in
// the outbox, a log or a crash report. The password is never shown again.
@Singleton
class MraLogin @Inject constructor(@ApplicationContext context: Context) {
    private val s = SecretStore(context, "mra_secrets")

    data class Login(val username: String, val password: String, val areaCode: String)
    class Token(val token: String, val key: ByteArray, val until: Long?, val signedAt: Long)

    // What Settings, MRA and the banner show: no password, no token.
    data class State(val username: String?, val areaCode: String?, val until: Long?, val refused: String?)

    private val _state = MutableStateFlow(read())
    val state: StateFlow<State> = _state

    private fun read() = State(s.get(USER), s.get(AREA), s.get(UNTIL)?.toLongOrNull(), s.get(REFUSED))
    private fun changed() { _state.value = read() }

    fun login(): Login? {
        val u = s.get(USER) ?: return null
        val p = s.get(PASSWORD) ?: return null
        return Login(u, p, s.get(AREA).orEmpty())
    }

    // a new login: what the old one was given goes with it
    fun save(username: String, password: String, areaCode: String) {
        s.put(USER, username.trim()); s.put(PASSWORD, password); s.put(AREA, areaCode.trim())
        dropToken(); listOf(REFUSED, REFUSED_AT).forEach { s.remove(it) }
        changed()
    }

    fun forget() {
        listOf(USER, PASSWORD, AREA, TOKEN, KEY, UNTIL, SIGNED, REFUSED, REFUSED_AT).forEach { s.remove(it) }
        changed()
    }

    fun token(): Token? {
        val t = s.get(TOKEN) ?: return null
        val k = s.get(KEY)?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() } ?: return null
        return Token(t, k, s.get(UNTIL)?.toLongOrNull(), s.get(SIGNED)?.toLongOrNull() ?: 0)
    }

    fun saveToken(token: String, key: ByteArray, until: Long?, now: Long) {
        s.put(TOKEN, token); s.put(KEY, Base64.getEncoder().encodeToString(key)); s.put(SIGNED, now.toString())
        if (until != null) s.put(UNTIL, until.toString()) else s.remove(UNTIL)
        listOf(REFUSED, REFUSED_AT).forEach { s.remove(it) }
        changed()
    }

    fun dropToken() {
        listOf(TOKEN, KEY, UNTIL, SIGNED).forEach { s.remove(it) }
        changed()
    }

    // the MRA's own words when it refused the login, and when
    fun refuse(why: String, now: Long) {
        s.put(REFUSED, why.take(300)); s.put(REFUSED_AT, now.toString())
        dropToken()
    }

    fun refusedAt(): Long? = s.get(REFUSED_AT)?.toLongOrNull()

    private companion object {
        const val USER = "mra.username"
        const val PASSWORD = "mra.password"
        const val AREA = "mra.area"
        const val TOKEN = "mra.token"
        const val KEY = "mra.key"
        const val UNTIL = "mra.until"
        const val SIGNED = "mra.signed"
        const val REFUSED = "mra.refused"
        const val REFUSED_AT = "mra.refused_at"
    }
}
