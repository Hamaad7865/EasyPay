package com.restopos.core.mra

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.security.PublicKey
import java.security.SecureRandom
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.util.Base64

// The MRA's two calls (its technical guide v1.3) as requests and answers, as
// mra/api.cjs: nothing here goes on the network (MraHttp sends).
//   - Sign-in (token generation): the header names the user, the EBS MRA ID
//     and the area code; the body is a request id and the login sealed with
//     the MRA's public key. The token lasts 24 hours; asked again while it has
//     more than 10 minutes left, the same one comes back.
//   - Transmission: the same header with the token; the body is a request id,
//     the time, an empty signature and the invoice list encrypted with the key
//     the sign-in gave. At most 500 invoices a request.
// The address is the MRA's test system until the production one is known; it
// comes from our server with the certificate (pos_settings.mra_connect).
object MraApi {
    const val TEST_BASE = "https://vfisc.mra.mu"
    fun tokenUrl(base: String) = base.trimEnd('/') + "/einvoice-token-service/token-api/generate-token"
    fun transmitUrl(base: String) = base.trimEnd('/') + "/realtime/invoice/transmit"

    data class Who(val username: String, val password: String, val ebsMraId: String, val areaCode: String)
    data class Request(val url: String, val headers: List<Pair<String, String>>, val body: String)

    fun requestId(now: Long = System.currentTimeMillis()): String =
        "EP$now" + ByteArray(4).also { SecureRandom().nextBytes(it) }.joinToString("") { (it.toInt() and 0xFF).toString(16).padStart(2, '0') }

    // the area code only when there is one: sign-in works without it, sending does not (ERR0020)
    private fun header(w: Who) = listOfNotNull(
        "Content-Type" to "application/json", "username" to w.username, "ebsMraId" to w.ebsMraId,
        w.areaCode.takeIf { it.isNotEmpty() }?.let { "areaCode" to it },
    )

    fun tokenRequest(base: String, w: Who, aesKey: ByteArray, refresh: Boolean, mraKey: PublicKey, id: String = requestId()): Request {
        val login = MraJson.encode(MraJson.obj(
            "username" to w.username, "password" to w.password,
            "encryptKey" to Base64.getEncoder().encodeToString(aesKey), "refreshToken" to (if (refresh) "true" else "false"),
        ))
        return Request(tokenUrl(base), header(w), MraJson.encode(MraJson.obj("requestId" to id, "payload" to MraCrypto.rsaEncrypt(mraKey, login))))
    }

    // invoices: each as MraInvoice.Built.text, sent as they were made
    fun transmitRequest(base: String, w: Who, token: String, invoiceKey: ByteArray, invoices: List<String>, now: Long, id: String = requestId(now)): Request =
        Request(transmitUrl(base), header(w) + ("token" to token), MraJson.encode(MraJson.obj(
            "requestId" to id,
            "requestDateTime" to MraInvoice.mraDateTime(now),
            "signedHash" to "",
            "encryptedInvoice" to MraCrypto.aesEncrypt(invoiceKey, MraInvoice.list(invoices)),
        )))

    sealed interface Token
    class Signed(val token: String, val invoiceKey: ByteArray, val expiryDate: String, val expiresAt: Long?) : Token
    data class Refused(val errors: List<String>) : Token

    fun readToken(answer: JsonObject, aesKey: ByteArray): Token {
        val status = answer.str("status")
        val token = answer.str("token")
        val key = answer.str("key")
        if (status != "SUCCESS" || token.isNullOrEmpty() || key.isNullOrEmpty()) {
            return Refused(said(answer["errors"]).ifEmpty { listOf(if (status != null) "status $status" else "no answer") })
        }
        val expiry = answer.str("expiryDate") ?: ""
        return Signed(token, MraCrypto.unwrapKey(key, aesKey), expiry, mraMoment(expiry))
    }

    data class Fiscal(val identifier: String, val status: String, val irn: String?, val qr: String?, val errors: List<String>, val warnings: List<String>)
    data class Transmitted(val status: String, val environment: String?, val responseId: String?, val errors: List<String>, val info: List<String>, val invoices: List<Fiscal>)

    fun readTransmit(a: JsonObject) = Transmitted(
        a.str("status") ?: "", a.str("environment"), a.str("responseId"), said(a["errorMessages"]), said(a["infoMessages"]),
        (a["fiscalisedInvoices"] as? JsonArray).orEmpty().map { e ->
            val f = e.jsonObject
            Fiscal(f.str("invoiceIdentifier") ?: "", f.str("status") ?: "", f.str("irn"), f.str("qrCode"), said(f["errorMessages"]), said(f["warningMessages"]))
        },
    )

    // "yyyyMMdd HH:mm:ss" in Mauritius time (UTC+4) as a moment
    fun mraMoment(text: String?): Long? {
        val m = Regex("""^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})""").find(text?.trim() ?: return null) ?: return null
        val (y, mo, d, h, mi, s) = m.destructured
        return runCatching {
            LocalDateTime.of(y.toInt(), mo.toInt(), d.toInt(), h.toInt(), mi.toInt(), s.toInt()).toInstant(ZoneOffset.ofHours(4)).toEpochMilli()
        }.getOrNull()
    }

    // the MRA's messages, as words or as {code, description}
    private fun said(e: JsonElement?): List<String> = (e as? JsonArray).orEmpty().mapNotNull { m ->
        when (m) {
            is JsonNull -> null
            is JsonPrimitive -> m.content
            is JsonObject -> "${(m.str("code") ?: "").trim()}: ${(m.str("description") ?: "").trim()}"
            else -> null
        }
    }

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
}
