package com.restopos.core.network

import android.content.Context
import android.util.Base64
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.restopos.core.common.SecretStore
import com.restopos.core.network.dto.AuthErrorBody
import com.restopos.core.network.dto.AuthRequest
import com.restopos.core.network.dto.TokenResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.cookies.AcceptAllCookiesStorage
import io.ktor.client.plugins.cookies.CookiesStorage
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Cookie
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.http.parseServerSetCookieHeader
import io.ktor.http.renderSetCookieHeader
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

// Earlier builds kept the token and cookies in this DataStore in clear text.
// It is read once, moved into the encrypted store, and emptied.
private val Context.legacyAuthPrefs by preferencesDataStore("session")
private val LEGACY_JWT = stringPreferencesKey("jwt")
private val LEGACY_COOKIES = stringSetPreferencesKey("cookies")

private const val KEY_JWT = "jwt"
private const val KEY_COOKIES = "cookies"
private const val ENTRY_SEPARATOR = "\u001e"

/** The session is gone (or was never there): the user has to sign in again. */
class AuthRequired(message: String = "Please sign in again") : Exception(message)

// Session cookies survive a restart, encrypted. Ktor's own storage is memory
// only, which meant the token could never be refreshed after the app was
// closed. Each entry is "<request url>\n<Set-Cookie header>".
private class PersistentCookies(private val secrets: SecretStore) : CookiesStorage {
    private var memory = AcceptAllCookiesStorage()
    private val mutex = Mutex()
    private var loaded = false
    private val entries = LinkedHashMap<String, String>()

    private suspend fun ensureLoaded() {
        if (loaded) return
        val saved = withContext(Dispatchers.IO) { secrets.get(KEY_COOKIES) }.orEmpty()
        for (entry in saved.split(ENTRY_SEPARATOR)) {
            if (entry.isEmpty()) continue
            val url = entry.substringBefore('\n')
            val header = entry.substringAfter('\n')
            runCatching {
                val cookie = parseServerSetCookieHeader(header)
                memory.addCookie(Url(url), cookie)
                entries[cookie.name] = entry
            }
        }
        loaded = true
    }

    override suspend fun get(requestUrl: Url): List<Cookie> = mutex.withLock {
        ensureLoaded()
        memory.get(requestUrl)
    }

    override suspend fun addCookie(requestUrl: Url, cookie: Cookie) = mutex.withLock {
        ensureLoaded()
        memory.addCookie(requestUrl, cookie)
        entries[cookie.name] = requestUrl.toString() + "\n" + renderSetCookieHeader(cookie)
        val snapshot = entries.values.joinToString(ENTRY_SEPARATOR)
        withContext(Dispatchers.IO) { secrets.put(KEY_COOKIES, snapshot) }
    }

    suspend fun clear() = mutex.withLock {
        entries.clear()
        memory = AcceptAllCookiesStorage()
        loaded = true
        withContext(Dispatchers.IO) { secrets.remove(KEY_COOKIES) }
    }

    override fun close() {}
}

// Neon Auth (Better Auth) over REST. Cookies hold the session; the JWT for the
// Function API comes from /token and is cached until shortly before it expires.
// Paths are the ones db/tests/signup-lock.test.cjs exercises against the branch.
// There is no sign-up: logins are created by the platform admin.
class AuthClient(private val context: Context, baseUrl: String) {
    private val authUrl = baseUrl.trimEnd('/')
    private val json = Json { ignoreUnknownKeys = true }
    private val secrets = SecretStore(context)
    private val cookies = PersistentCookies(secrets)
    private val http = HttpClient(OkHttp) {
        install(ContentNegotiation) { json(json) }
        install(HttpCookies) { storage = cookies }
    }
    private val migration = Mutex()
    private var migrated = false

    // Runs before anything reads the session, so a tablet updated from an
    // earlier build stays signed in and loses its clear-text copy.
    private suspend fun migrateLegacy() = migration.withLock {
        if (migrated) return@withLock
        runCatching {
            val old = context.legacyAuthPrefs.data.first()
            val jwt = old[LEGACY_JWT]
            val oldCookies = old[LEGACY_COOKIES]
            if (jwt != null || oldCookies != null) {
                withContext(Dispatchers.IO) {
                    if (!jwt.isNullOrBlank() && secrets.get(KEY_JWT) == null) secrets.put(KEY_JWT, jwt)
                    if (!oldCookies.isNullOrEmpty() && secrets.get(KEY_COOKIES) == null) {
                        secrets.put(KEY_COOKIES, oldCookies.joinToString(ENTRY_SEPARATOR))
                    }
                }
                context.legacyAuthPrefs.edit { it.clear() }
            }
        }
        migrated = true
    }

    suspend fun signIn(email: String, password: String): Result<Unit> = runCatching {
        migrateLegacy()
        val res = http.post("$authUrl/sign-in/email") {
            contentType(ContentType.Application.Json)
            setBody(AuthRequest(email, password))
        }
        if (!res.status.isSuccess()) error(failure(res, "Sign-in failed"))
        refreshJwt()
        Unit
    }

    // Works offline: the server call is best effort, local state always goes.
    suspend fun signOut() {
        migrateLegacy()
        runCatching { http.post("$authUrl/sign-out") { contentType(ContentType.Application.Json); setBody("{}") } }
        withContext(Dispatchers.IO) { secrets.remove(KEY_JWT) }
        cookies.clear()
    }

    /**
     * A token that is still good for at least a minute, refreshed from the
     * session when needed. Throws [AuthRequired] when the session is gone and
     * an IO exception when the network is.
     */
    suspend fun jwt(forceRefresh: Boolean = false): String {
        migrateLegacy()
        val cached = withContext(Dispatchers.IO) { secrets.get(KEY_JWT) }
        if (!forceRefresh && !cached.isNullOrBlank() && !expiresSoon(cached)) return cached
        return refreshJwt()
    }

    private suspend fun refreshJwt(): String {
        val res = http.get("$authUrl/token")
        if (res.status == HttpStatusCode.Unauthorized) {
            withContext(Dispatchers.IO) { secrets.remove(KEY_JWT) }
            throw AuthRequired()
        }
        if (!res.status.isSuccess()) error(failure(res, "Could not refresh the session"))
        val token = res.body<TokenResponse>().token
        if (token.isBlank()) throw AuthRequired()
        withContext(Dispatchers.IO) { secrets.put(KEY_JWT, token) }
        return token
    }

    private fun expiresSoon(jwt: String): Boolean = runCatching {
        val payload = Base64.decode(jwt.split('.')[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        val exp = json.parseToJsonElement(String(payload)).jsonObject["exp"]?.jsonPrimitive?.longOrNull
            ?: return true
        exp * 1000 - System.currentTimeMillis() < 60_000
    }.getOrDefault(true)

    private suspend fun failure(res: HttpResponse, fallback: String): String {
        val message = runCatching { json.decodeFromString<AuthErrorBody>(res.bodyAsText()).message }.getOrNull()
        return message?.takeIf { it.isNotBlank() } ?: "$fallback (${res.status.value})"
    }
}
