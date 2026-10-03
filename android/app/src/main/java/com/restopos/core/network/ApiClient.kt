package com.restopos.core.network

import com.restopos.core.network.dto.MeResponse
import com.restopos.core.network.dto.OpResult
import com.restopos.core.network.dto.OutboxOp
import com.restopos.core.network.dto.PullResponse
import com.restopos.core.network.dto.RegisterDeviceRequest
import com.restopos.core.network.dto.RegisterDeviceResponse
import com.restopos.core.network.dto.SignupRequest
import com.restopos.core.network.dto.SignupResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

// Function API client. Screens never touch this; repositories do (spec 15).
// tenant_id/store_id/employee_id are stamped server-side from the JWT.
class ApiClient constructor(val functionUrl: String, private val auth: AuthClient) {
    private val json = Json { ignoreUnknownKeys = true }
    private val http = HttpClient(Android) {
        install(ContentNegotiation) { json(json) }
    }

    private suspend fun token(): String {
        val t = auth.jwt() ?: error("not signed in")
        return t.removePrefix("Bearer ").let { t }
    }

    suspend fun me(): MeResponse = http.get("${functionUrl}me") {
        bearerAuth(token())
    }.body()

    suspend fun registerDevice(req: RegisterDeviceRequest): RegisterDeviceResponse =
        http.post("${functionUrl}devices/register") {
            bearerAuth(token())
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    suspend fun pull(storeId: String, cursor: Long, limit: Int = 200): PullResponse =
        http.get("${functionUrl}sync/pull") {
            bearerAuth(token())
            parameter("storeId", storeId)
            parameter("cursor", cursor)
            parameter("limit", limit)
        }.body()

    suspend fun push(ops: List<OutboxOp>): List<OpResult> =
        http.post("${functionUrl}sync/push") {
            bearerAuth(token())
            contentType(ContentType.Application.Json)
            setBody(mapOf("ops" to ops))
        }.body()

    suspend fun signup(req: SignupRequest, rawToken: String? = null): SignupResponse =
        http.post("${functionUrl}signup") {
            (rawToken ?: auth.jwt())?.let { bearerAuth(it.removePrefix("Bearer ")) }
            contentType(ContentType.Application.Json)
            setBody(req)
        }.body()

    suspend fun seedDemo(): String =
        http.post("${functionUrl}seed-demo") { bearerAuth(token()) }.body()
}
