package com.restopos.core.network

import com.restopos.core.data.ZMailRules
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.TimeUnit

// EasyPay's mail service (cloudflare/mail), where a till sends its Z report.
// Its own client: the service is not EasyPay's till service, takes no login
// and no till key of the server's, and is asked by every tablet, offline ones
// included. The till's own key for the address goes in the body, never in an
// address that a log could keep.
class MailClient(baseUrl: String) {
    private val base = baseUrl.trimEnd('/')
    private val json = Json { ignoreUnknownKeys = true }
    private val http = HttpClient(OkHttp) {
        engine { config { connectTimeout(15, TimeUnit.SECONDS); readTimeout(30, TimeUnit.SECONDS) } }
        // an answer of 4xx or 5xx is read like any other: what it says matters
        expectSuccess = false
    }

    // POST /v1/ask, /v1/state, /v1/z or /v1/stop. Null when nothing answered:
    // no connection, or the service is not up.
    suspend fun call(what: String, body: JsonObject): ZMailRules.Answer? = runCatching {
        val res = http.post("$base/v1/$what") { contentType(ContentType.Application.Json); setBody(body.toString()) }
        val said = runCatching { json.parseToJsonElement(res.bodyAsText()).jsonObject }.getOrNull()
        val text = { k: String -> said?.get(k)?.jsonPrimitive?.contentOrNull }
        ZMailRules.Answer(res.status.value, text("state"), text("error"), text("code"), said?.get("sent")?.jsonPrimitive?.booleanOrNull == true)
    }.getOrNull()

    companion object {
        // the release's: the address in every till
        const val LIVE = "https://mail.easypaypos.com"
    }
}
