package com.restopos.core.mra

import com.restopos.core.database.MraInvoiceEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import kotlin.math.abs

// What the next document of a till goes to the MRA as, or why the payment is
// not taken (docs/superpowers/plans/2026-10-21-mra-phase-2-till.md, Task 11;
// design section 7). Pure: the caller reads the till and the sale.
object MraIssue {
    sealed interface Plan
    // the business does not send to the MRA (off, setting up), or a training till has no EBS MRA ID
    data object Skip : Plan
    data class Refuse(val why: String) : Plan
    data class Issue(val type: String, val counter: Long, val identifier: String, val previous: Chained?) : Plan

    const val CLOCK_LIMIT_MS = 5 * 60_000L

    fun plan(
        mode: String,
        ebsId: String?,
        // this till's MRA counter and chains have come from the server since it was set up
        restored: Boolean,
        refund: Boolean,
        // the refunded sale went to the MRA as a training invoice
        refundOfTraining: Boolean,
        number: String,
        counter: Long,
        chain: String?,
        lastIssuedAt: Long?,
        // how far this tablet's clock is ahead of the server's, when known
        clockAheadMs: Long?,
        now: Long,
        refusal: String?,
    ): Plan {
        if (mode != "training" && mode != "live") return Skip
        if (ebsId.isNullOrBlank()) return if (mode == "live") Refuse("This till has no EBS MRA ID, so its sales cannot go to the MRA. Ask EasyPay.") else Skip
        if (!restored) return Refuse("This till has not had its MRA numbers back from EasyPay yet. Let it sync, then take the payment.")
        if (clockAheadMs != null && abs(clockAheadMs) > CLOCK_LIMIT_MS) {
            return Refuse("This tablet's clock is more than 5 minutes off. Set its date and time, then take the payment.")
        }
        if (lastIssuedAt != null && now < lastIssuedAt) {
            return Refuse("This tablet's clock is earlier than its last invoice to the MRA. Set its date and time, then take the payment.")
        }
        refusal?.let { return Refuse(it) }
        // a refund of a training sale is a training document too: a CRN names an STD
        val type = if (mode == "training" || (refund && refundOfTraining)) "TRN" else if (refund) "CRN" else "STD"
        val next = counter + 1
        // receipt numbers start again at Go live; a training number must never be a real one's
        val identifier = if (type == "TRN") "TRN" + next.toString().padStart(8, '0') else number
        return Issue(type, next, identifier, MraChain.last(chain, type)?.second)
    }

    // What the server is told of a document (mra.record, server 0132): never
    // the login, the token or a key; the invoice as it was sent.
    fun record(e: MraInvoiceEntity): JsonObject = buildJsonObject {
        put("id", e.id); put("store_id", e.store_id); put("device_id", e.device_id); put("ebs_id", e.ebs_id)
        e.receipt_id?.let { put("receipt_id", it) }
        put("type", e.type); put("counter", e.counter); put("identifier", e.identifier)
        e.ref_identifier?.let { put("ref_identifier", it) }
        put("previous_hash", e.previous_hash); put("invoice", e.invoice)
        put("issued_at", Instant.ofEpochMilli(e.issued_at).toString())
        put("status", e.status)
        e.irn?.let { put("irn", it) }
        e.qr?.let { put("qr", it) }
        put("errors", list(e.errors)); put("warnings", list(e.warnings))
        e.answered_at?.let { put("answered_at", Instant.ofEpochMilli(it).toString()) }
        e.response_id?.let { put("response_id", it) }
    }

    private fun list(text: String) = runCatching { Json.parseToJsonElement(text) as JsonArray }.getOrElse { JsonArray(emptyList()) }

    // a telephone number as the MRA takes it: digits and +, at most 20
    fun phone(p: String): String = p.filter { it.isDigit() || it == '+' }.take(20)
}
