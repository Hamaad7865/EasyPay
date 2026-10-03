package com.restopos.core.network

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.restopos.core.network.dto.AuthRequest
import com.restopos.core.network.dto.SessionResponse
import com.restopos.core.network.dto.TokenResponse
import dagger.hilt.android.qualifiers.ApplicationContext
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.cookies.AcceptAllCookiesStorage
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json

private val Context.sessionStore by preferencesDataStore("session")

// Better Auth over REST. Cookies hold the session; the JWT (for the Function
// API) comes from the JWT plugin's /token endpoint and is cached in DataStore.
// Assumption to verify on device: Managed Auth exposes /sign-in/email,
// /sign-up/email and /token. If the paths differ, only this file changes.
class AuthClient constructor(@ApplicationContext private val context: Context, val authUrl: String) {
    private val json = Json { ignoreUnknownKeys = true }
    private val http = HttpClient(Android) {
        install(ContentNegotiation) { json(json) }
        install(HttpCookies) { storage(AcceptAllCookiesStorage()) }
    }
    private val JWT = stringPreferencesKey("jwt")

    suspend fun signIn(email: String, password: String): Result<Unit> = runCatching {
        http.post("$authUrl/sign-in/email") {
            contentType(ContentType.Application.Json)
            setBody(AuthRequest(email, password))
        }
        refreshJwt()
    }

    suspend fun signUp(name: String, email: String, password: String): Result<Unit> = runCatching {
        http.post("$authUrl/sign-up/email") {
            contentType(ContentType.Application.Json)
            setBody(AuthRequest(email, password, name))
        }
        refreshJwt()
    }

    suspend fun signOut() {
        http.post("$authUrl/sign-out") {}
        context.sessionStore.edit { it.remove(JWT) }
    }

    suspend fun jwt(): String? {
        val cached = context.sessionStore.data.map { it[JWT] }.first()
        if (!cached.isNullOrBlank()) return cached
        return refreshJwt().getOrNull()
    }

    suspend fun refreshJwt(): Result<String> = runCatching {
        val res: TokenResponse = http.get("$authUrl/token").body()
        require(res.token.isNotBlank()) { "empty token" }
        context.sessionStore.edit { it[JWT] = res.token }
        res.token
    }

    suspend fun authHeader(): String? = jwt()?.let { "Bearer $it" }

    suspend fun sessionUserId(): String? = runCatching {
        val res: SessionResponse = http.get("$authUrl/get-session").body()
        res.user?.id
    }.getOrNull()
}
