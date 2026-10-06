package com.restopos.core.network

import com.restopos.core.network.dto.ApiErrorBody
import com.restopos.core.network.dto.MeResponse
import com.restopos.core.network.dto.OpResult
import com.restopos.core.network.dto.OutboxOp
import com.restopos.core.network.dto.PullResponse
import com.restopos.core.network.dto.PushRequest
import com.restopos.core.network.dto.RegisterDeviceRequest
import com.restopos.core.network.dto.RegisterDeviceResponse
import com.restopos.core.network.dto.TillKeyRequest
import com.restopos.core.network.dto.TillKeyResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.delete
import io.ktor.client.request.header
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json

/** The Function API answered, but not with success. */
class ApiError(val status: Int, message: String) : Exception(message)

// Function API client. Screens never touch this; repositories do (spec 15).
// tenant_id/store_id/employee_id are stamped server-side from the JWT.
class ApiClient(baseUrl: String, private val auth: AuthClient, private val version: Int = 0) {
    private val functionUrl = baseUrl.trimEnd('/')
    private val json = Json { ignoreUnknownKeys = true }
    private val http = HttpClient(OkHttp) {
        install(ContentNegotiation) { json(json) }
        // every call says which build of the till is asking
        defaultRequest { header(VERSION_HEADER, version.toString()) }
    }

    // How far this tablet's clock is ahead of the server's, in milliseconds
    // (negative: behind). Null until the server has answered once. A receipt
    // is dated by the tablet, so a clock that is hours out puts sales on the
    // wrong day.
    val clockAhead = MutableStateFlow<Long?>(null)

    // The server has said this build is too old to sync (HTTP 426). Nothing
    // is lost: the till keeps selling and keeps its outbox until it is updated.
    val updateRequired = MutableStateFlow(false)

    private fun noteClock(res: HttpResponse) {
        val at = res.headers["Date"]?.let {
            runCatching { java.time.ZonedDateTime.parse(it, java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }.getOrNull()
        } ?: return
        clockAhead.value = System.currentTimeMillis() - at
    }

    // Every call goes through here. A sync call (push, pull, crash reports)
    // goes with the till's own key when it has one: that key does not lapse,
    // so syncing does not wait on the login's session, which ends after a
    // week without a connection. A key the server no longer takes (401: it
    // was ended or is not this till's; 403: the till was deactivated, or the
    // login that set it up was switched off) is dropped and the login is
    // used, as before tills had keys: whoever is signed in on the till can
    // send its sales, and the next pull gets the till a new key under them.
    // With the login, a 401 refreshes the token once and retries. Anything
    // that is not a success becomes an ApiError instead of being parsed as if
    // it were the expected body.
    private suspend fun authed(sync: Boolean = false, call: suspend (authorization: String) -> HttpResponse): HttpResponse {
        if (sync) {
            auth.tillKey()?.let { key ->
                val res = call("Device $key")
                if (res.status != HttpStatusCode.Unauthorized && res.status != HttpStatusCode.Forbidden) return checked(res)
                auth.clearTillKey()
            }
        }
        var res = call("Bearer " + auth.jwt())
        if (res.status == HttpStatusCode.Unauthorized) res = call("Bearer " + auth.jwt(forceRefresh = true))
        return checked(res)
    }

    private suspend fun checked(res: HttpResponse): HttpResponse {
        noteClock(res)
        if (res.status.value == UPDATE_REQUIRED) {
            updateRequired.value = true
            throw ApiError(UPDATE_REQUIRED, "This till must be updated before it can sync")
        }
        if (res.status == HttpStatusCode.Unauthorized) throw AuthRequired()
        updateRequired.value = false
        if (!res.status.isSuccess()) {
            val text = res.bodyAsText()
            val message = runCatching { json.decodeFromString<ApiErrorBody>(text).error }.getOrNull()
            throw ApiError(res.status.value, message?.takeIf { it.isNotBlank() } ?: "Request failed (${res.status.value})")
        }
        return res
    }

    suspend fun me(): MeResponse =
        authed { a -> http.get("$functionUrl/me") { header(HttpHeaders.Authorization, a) } }.body()

    // Setting the till up also gives it its key for syncing.
    suspend fun registerDevice(req: RegisterDeviceRequest): RegisterDeviceResponse {
        val out: RegisterDeviceResponse = authed { a ->
            http.post("$functionUrl/devices/register") {
                header(HttpHeaders.Authorization, a)
                contentType(ContentType.Application.Json)
                setBody(req)
            }
        }.body()
        out.syncKey?.let { auth.saveTillKey(out.deviceId, it) }
        return out
    }

    suspend fun hasTillKey(): Boolean = auth.tillKey() != null

    // A till set up before tills had keys, or whose key was ended, asks for
    // one with its login.
    suspend fun fetchTillKey(deviceId: String) {
        val out: TillKeyResponse = authed { a ->
            http.post("$functionUrl/devices/key") {
                header(HttpHeaders.Authorization, a)
                contentType(ContentType.Application.Json)
                setBody(TillKeyRequest(deviceId))
            }
        }.body()
        auth.saveTillKey(out.deviceId, out.syncKey)
    }

    // The tablet is being signed out: its key is ended on the server, as far
    // as that can be reached, and is gone from the tablet either way.
    suspend fun endTillKey() {
        val key = auth.tillKey() ?: return
        runCatching { http.delete("$functionUrl/devices/key") { header(HttpHeaders.Authorization, "Device $key") } }
        auth.clearTillKey()
    }

    suspend fun pull(storeId: String, cursor: Long, limit: Int = 200): PullResponse =
        authed(sync = true) { a ->
            http.get("$functionUrl/sync/pull") {
                header(HttpHeaders.Authorization, a)
                parameter("storeId", storeId)
                parameter("cursor", cursor)
                parameter("limit", limit)
            }
        }.body()

    // One result per op, in order. Statuses: applied, rejected (with a code),
    // retry (transient: this op and every later one were not processed).
    suspend fun push(ops: List<OutboxOp>): List<OpResult> =
        authed(sync = true) { a ->
            http.post("$functionUrl/sync/push") {
                header(HttpHeaders.Authorization, a)
                contentType(ContentType.Application.Json)
                setBody(PushRequest(ops))
            }
        }.body()

    // What the till wrote down when it stopped unexpectedly (core/common/Crashes).
    suspend fun crashes(reports: List<kotlinx.serialization.json.JsonObject>) {
        authed(sync = true) { a ->
            http.post("$functionUrl/crash") {
                header(HttpHeaders.Authorization, a)
                contentType(ContentType.Application.Json)
                setBody(kotlinx.serialization.json.buildJsonObject { put("reports", kotlinx.serialization.json.JsonArray(reports)) })
            }
        }
    }

    suspend fun seedDemo() {
        authed { a -> http.post("$functionUrl/seed-demo") { header(HttpHeaders.Authorization, a) } }
    }

    companion object {
        const val VERSION_HEADER = "X-Till-Version"
        const val UPDATE_REQUIRED = 426
    }
}
