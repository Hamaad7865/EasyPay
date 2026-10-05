package com.restopos.core.network

import com.restopos.core.network.dto.ApiErrorBody
import com.restopos.core.network.dto.MeResponse
import com.restopos.core.network.dto.OpResult
import com.restopos.core.network.dto.OutboxOp
import com.restopos.core.network.dto.PullResponse
import com.restopos.core.network.dto.PushRequest
import com.restopos.core.network.dto.RegisterDeviceRequest
import com.restopos.core.network.dto.RegisterDeviceResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.header
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
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

    // Every call goes through here: a 401 refreshes the token once and retries,
    // and anything that is not a success becomes an ApiError instead of being
    // parsed as if it were the expected body.
    private suspend fun authed(call: suspend (token: String) -> HttpResponse): HttpResponse {
        var res = call(auth.jwt())
        if (res.status == HttpStatusCode.Unauthorized) res = call(auth.jwt(forceRefresh = true))
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
        authed { token -> http.get("$functionUrl/me") { bearerAuth(token) } }.body()

    suspend fun registerDevice(req: RegisterDeviceRequest): RegisterDeviceResponse =
        authed { token ->
            http.post("$functionUrl/devices/register") {
                bearerAuth(token)
                contentType(ContentType.Application.Json)
                setBody(req)
            }
        }.body()

    suspend fun pull(storeId: String, cursor: Long, limit: Int = 200): PullResponse =
        authed { token ->
            http.get("$functionUrl/sync/pull") {
                bearerAuth(token)
                parameter("storeId", storeId)
                parameter("cursor", cursor)
                parameter("limit", limit)
            }
        }.body()

    // One result per op, in order. Statuses: applied, rejected (with a code),
    // retry (transient: this op and every later one were not processed).
    suspend fun push(ops: List<OutboxOp>): List<OpResult> =
        authed { token ->
            http.post("$functionUrl/sync/push") {
                bearerAuth(token)
                contentType(ContentType.Application.Json)
                setBody(PushRequest(ops))
            }
        }.body()

    suspend fun seedDemo() {
        authed { token -> http.post("$functionUrl/seed-demo") { bearerAuth(token) } }
    }

    companion object {
        const val VERSION_HEADER = "X-Till-Version"
        const val UPDATE_REQUIRED = 426
    }
}
