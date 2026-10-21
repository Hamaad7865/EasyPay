package com.restopos.core.mra

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.time.Instant
import java.util.Base64
import javax.crypto.Cipher

// The MRA's two calls as requests and answers, as mra/api.test.cjs holds
// mra/api.cjs.
class MraApiTest {
    private val who = MraApi.Who("dev@example.mu", "not-a-real-one", "EBS123", "100")
    private val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    private fun open(sealed: String) = String(Cipher.getInstance("RSA/ECB/PKCS1Padding").apply { init(Cipher.DECRYPT_MODE, pair.private) }
        .doFinal(Base64.getDecoder().decode(sealed)), Charsets.UTF_8)

    @Test fun theSignInNamesTheUserTheEbsAndTheAreaAndSealsTheLogin() {
        val aesKey = ByteArray(32) { 7 }
        val r = MraApi.tokenRequest(MraApi.TEST_BASE, who, aesKey, false, pair.public, "REQ-1")
        assertEquals("https://vfisc.mra.mu/einvoice-token-service/token-api/generate-token", r.url)
        assertEquals(listOf("Content-Type" to "application/json", "username" to "dev@example.mu", "ebsMraId" to "EBS123", "areaCode" to "100"), r.headers)
        val body = Json.parseToJsonElement(r.body).jsonObject
        assertEquals(listOf("requestId", "payload"), body.keys.toList())
        assertEquals("REQ-1", body["requestId"]!!.jsonPrimitive.content)
        val login = open(body["payload"]!!.jsonPrimitive.content)
        assertEquals("""{"username":"dev@example.mu","password":"not-a-real-one","encryptKey":"${Base64.getEncoder().encodeToString(aesKey)}","refreshToken":"false"}""", login)
    }

    // with none, the header has no areaCode at all, not an empty one
    @Test fun withNoAreaCodeNeitherRequestNamesOne() {
        val none = who.copy(areaCode = "")
        assertEquals(listOf("Content-Type", "username", "ebsMraId"), MraApi.tokenRequest(MraApi.TEST_BASE, none, ByteArray(32), false, pair.public, "R").headers.map { it.first })
        assertEquals(listOf("Content-Type", "username", "ebsMraId", "token"), MraApi.transmitRequest(MraApi.TEST_BASE, none, "tok", ByteArray(32), emptyList(), 0, "R").headers.map { it.first })
    }

    @Test fun aSignInForANewTokenSaysRefreshTokenTrue() {
        val r = MraApi.tokenRequest(MraApi.TEST_BASE, who, ByteArray(32) { 1 }, true, pair.public, "REQ-2")
        assertTrue(open(Json.parseToJsonElement(r.body).jsonObject["payload"]!!.jsonPrimitive.content).endsWith(""""refreshToken":"true"}"""))
    }

    @Test fun aSuccessfulSignInGivesTheTokenTheKeyAndWhenItEnds() {
        val aesKey = ByteArray(32) { 7 }
        val invoiceKey = ByteArray(32) { 9 }
        val answer = Json.parseToJsonElement("""{"responseId":"TK1","requestId":"REQ-1","status":"SUCCESS","token":"tok","key":"${MraCrypto.aesEncrypt(aesKey, Base64.getEncoder().encodeToString(invoiceKey))}","expiryDate":"20261022 16:10:00"}""").jsonObject
        val s = MraApi.readToken(answer, aesKey) as MraApi.Signed
        assertEquals("tok", s.token)
        assertArrayEquals(invoiceKey, s.invoiceKey)
        assertEquals("20261022 16:10:00", s.expiryDate)
        assertEquals(Instant.parse("2026-10-22T12:10:00Z").toEpochMilli(), s.expiresAt)
    }

    @Test fun aRefusedSignInGivesItsErrors() {
        assertEquals(MraApi.Refused(listOf("Invalid Header Request")), MraApi.readToken(Json.parseToJsonElement("""{"status":"ERROR","errors":["Invalid Header Request"]}""").jsonObject, ByteArray(32)))
        assertEquals(MraApi.Refused(listOf("status ERROR")), MraApi.readToken(Json.parseToJsonElement("""{"status":"ERROR","errors":null}""").jsonObject, ByteArray(32)))
    }

    @Test fun anInvoiceListGoesEncryptedWithTheTokenInTheHeader() {
        val invoiceKey = ByteArray(32) { 9 }
        val list = listOf("""{"invoiceIdentifier":"EP-1","totalAmtPaid":"23.00"}""")
        val r = MraApi.transmitRequest(MraApi.TEST_BASE, who, "tok", invoiceKey, list, Instant.parse("2026-10-21T12:00:00Z").toEpochMilli(), "REQ-3")
        assertEquals("https://vfisc.mra.mu/realtime/invoice/transmit", r.url)
        assertEquals(listOf("Content-Type" to "application/json", "username" to "dev@example.mu", "ebsMraId" to "EBS123", "areaCode" to "100", "token" to "tok"), r.headers)
        val body = Json.parseToJsonElement(r.body).jsonObject
        assertEquals(listOf("requestId", "requestDateTime", "signedHash", "encryptedInvoice"), body.keys.toList())
        assertEquals("20261021 16:00:00", body["requestDateTime"]!!.jsonPrimitive.content)
        assertEquals("", body["signedHash"]!!.jsonPrimitive.content)
        assertEquals("""[{"invoiceIdentifier":"EP-1","totalAmtPaid":"23.00"}]""", MraCrypto.aesDecrypt(invoiceKey, body["encryptedInvoice"]!!.jsonPrimitive.content))
    }

    @Test fun theAnswerSaysForEachInvoiceItsIrnAndQrOrItsErrors() {
        val a = MraApi.readTransmit(Json.parseToJsonElement("""{"responseId":"R1","responseDateTime":"20261021 16:00:01","requestId":"REQ-3","status":"HAS_ERROR","environment":"TEST","infoMessages":null,"errorMessages":null,
            "fiscalisedInvoices":[{"invoiceIdentifier":"EP-1","irn":"abc-123","qrCode":"iVBORw0KGgo=","status":"SUCCESS","warningMessages":null,"errorMessages":null},
            {"invoiceIdentifier":"EP-2","irn":null,"qrCode":null,"status":"ERROR","warningMessages":null,"errorMessages":[{"code":"LV_ERR002","description":"TAN does not match"}]}]}""").jsonObject)
        assertEquals("HAS_ERROR", a.status); assertEquals("TEST", a.environment); assertEquals("R1", a.responseId)
        assertEquals(MraApi.Fiscal("EP-1", "SUCCESS", "abc-123", "iVBORw0KGgo=", emptyList(), emptyList()), a.invoices[0])
        assertEquals(MraApi.Fiscal("EP-2", "ERROR", null, null, listOf("LV_ERR002: TAN does not match"), emptyList()), a.invoices[1])
        assertEquals(listOf("ERR0050: Token is not valid"), MraApi.readTransmit(Json.parseToJsonElement("""{"status":"ERROR","errorMessages":[{"code":"ERR0050","description":"Token is not valid"}]}""").jsonObject).errors)
    }

    @Test fun aRequestIdIsUniqueAndAtMost50Characters() {
        val a = MraApi.requestId(); val b = MraApi.requestId()
        assertNotEquals(a, b)
        assertTrue(a.length <= 50)
    }

    @Test fun aMauritiusTimeIsAMoment() {
        assertEquals(Instant.parse("2026-10-22T12:10:00Z").toEpochMilli(), MraApi.mraMoment("20261022 16:10:00"))
        assertEquals(null, MraApi.mraMoment("tomorrow"))
        assertEquals(null, MraApi.mraMoment(null))
    }

    @Test fun anotherAddressForProduction() {
        assertEquals("https://example.mu/realtime/invoice/transmit", MraApi.transmitUrl("https://example.mu"))
        assertEquals("https://example.mu/realtime/invoice/transmit", MraApi.transmitUrl("https://example.mu/"))
    }

    // the MRA's errors list may hold words or {code, description}
    @Test fun messagesAsWordsOrCodes() {
        val a = MraApi.readTransmit(Json.parseToJsonElement("""{"status":"ERROR","errorMessages":["Invalid Header Request",{"code":" ERR0300 ","description":"username should not be blank"}],"fiscalisedInvoices":[]}""").jsonObject)
        assertEquals(listOf("Invalid Header Request", "ERR0300: username should not be blank"), a.errors)
        assertTrue(a.invoices.isEmpty())
        assertEquals(0, Json.parseToJsonElement("[]").jsonArray.size)
    }
}
