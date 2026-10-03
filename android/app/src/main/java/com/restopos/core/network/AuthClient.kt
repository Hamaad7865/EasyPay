package com.restopos.core.network

import android.content.Context
import android.util.Base64
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

private val Context.authPrefs by preferencesDataStore("session")
private val JWT = stringPreferencesKey("jwt")
private val COOKIES = stringSetPreferencesKey("cookies")

/** The session is gone (or was never there): the user has to sign in again. */
class AuthRequired(message: String = "Please sign in again") : Exception(message)

// Session cookies survive a restart. Ktor's own storage is memory only, which
// meant the token could never be refreshed after the app was closed.
// Each entry is "<request url>\n<Set-Cookie header>".
private class PersistentCookies(private val context: Context) : CookiesStorage {
    private val memory = AcceptAllCookiesStorage()
    private val mutex = Mutex()
    private var loaded = false
    private val entries = LinkedHashMap<String, String>()

    private suspend fun ensureLoaded() {
        if (loaded) return
        val saved = context.authPrefs.data.map { it[COOKIES] ?: emptySet() }.first()
        for (entry in saved) {
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
        val snapshot = entries.values.toSet()
        context.authPrefs.edit { it[COOKIES] = snapshot }
        Unit
    }

    suspend fun clear() = mutex.withLock {
        entries.clear()
        loaded = false
        context.authPrefs.edit { it.remove(COOKIES) }
        Unit
    }

    override fun close() {}
}

// Neon Auth (Better Auth) over REST. Cookies hold the session; the JWT for the
// Function API comes from /token and is cached until shortly before it expires.
// Paths are the ones db/tests/signup-lock.test.cjs exercises against the branch.
class AuthClient(private val context: Context, baseUrl: String) {
    private val authUrl = baseUrl.trimEnd('/')
    private val json = Json { ignoreUnknownKeys = true }
    private val cookies = PersistentCookies(context)
    private val http = HttpClient(OkHttp) {
        install(ContentNegotiation) { json(json) }
        install(HttpCookies) { storage = cookies }
    }

    suspend fun signIn(email: String, password: String): Result<Unit> = runCatching {
        val res = http.post("$authUrl/sign-in/email") {
            contentType(ContentType.Application.Json)
            setBody(AuthRequest(email, password))
        }
        if (!res.status.isSuccess()) error(failure(res, "Sign-in failed"))
        refreshJwt()
        Unit
    }

    suspend fun signUp(name: String, email: String, password: String): Result<Unit> = runCatching {
        val res = http.post("$authUrl/sign-up/email") {
            contentType(ContentType.Application.Json)
            setBody(AuthRequest(email, password, name))
        }
        if (!res.status.isSuccess()) error(failure(res, "Sign-up failed"))
        refreshJwt()
        Unit
    }

    // Works offline: the server call is best effort, local state always goes.
    suspend fun signOut() {
        runCatching { http.post("$authUrl/sign-out") { contentType(ContentType.Application.Json); setBody("{}") } }
        context.authPrefs.edit { it.remove(JWT) }
        cookies.clear()
    }

    /**
     * A token that is still good for at least a minute, refreshed from the
     * session when needed. Throws [AuthRequired] when the session is gone and
     * an IO exception when the network is.
     */
    suspend fun jwt(forceRefresh: Boolean = false): String {
        val cached = context.authPrefs.data.map { it[JWT] }.first()
        if (!forceRefresh && !cached.isNullOrBlank() && !expiresSoon(cached)) return cached
        return refreshJwt()
    }

    private suspend fun refreshJwt(): String {
        val res = http.get("$authUrl/token")
        if (res.status == HttpStatusCode.Unauthorized) {
            context.authPrefs.edit { it.remove(JWT) }
            throw AuthRequired()
        }
        if (!res.status.isSuccess()) error(failure(res, "Could not refresh the session"))
        val token = res.body<TokenResponse>().token
        if (token.isBlank()) throw AuthRequired()
        context.authPrefs.edit { it[JWT] = token }
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
