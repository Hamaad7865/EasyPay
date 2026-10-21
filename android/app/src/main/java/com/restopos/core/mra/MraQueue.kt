package com.restopos.core.mra

import com.restopos.core.database.MraInvoiceEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

// What a till sends the MRA next, and what an answer means for what was sent
// (docs/superpowers/plans/2026-10-21-mra-phase-2-till.md, Task 12; the MRA's
// technical guide 9.1). Pure: MraSender does the sending.
//   - the oldest first, at most 500 a request;
//   - a credit note waits for its sale when the sale is this till's and the
//     MRA has not answered for it yet: an original before its refund;
//   - each send is written down before it goes (MraDao.sending): an answer
//     for an invoice settles it for good; no answer leaves it unsure, sent
//     once more later, then left for a manager to check; a request that never
//     reached the MRA, or that the MRA refused whole, puts it back as it was.
object MraQueue {
    const val MAX = 500

    // statuses: this till's documents by identifier (the sales the credit notes name)
    fun next(waiting: List<MraInvoiceEntity>, statuses: Map<String, String>, ebsId: String): List<MraInvoiceEntity> {
        val out = ArrayList<MraInvoiceEntity>()
        for (e in waiting.sortedBy { it.counter }) {
            if (out.size >= MAX) break
            // an invoice of another EBS (the ID moved to another till) is not sent under this one
            if (e.ebs_id != ebsId) continue
            if (e.type == "CRN") {
                val sale = e.ref_identifier?.let { statuses[it] }
                if (sale != null && sale != "fiscalised" && sale != "refused") break
            }
            out += e
        }
        return out
    }

    sealed interface Read
    // the MRA answered for these invoices (by identifier)
    data class Answered(val each: Map<String, MraApi.Fiscal>, val responseId: String?) : Read
    // the MRA refused the request as a whole: it answered for none of them
    data class RefusedWhole(val errors: List<String>, val token: Boolean) : Read
    // the request never reached the MRA
    data object NotReached : Read
    // it went, and nothing came back that says what became of it
    data object NoAnswer : Read

    private val json = Json { ignoreUnknownKeys = true }

    fun read(out: MraHttp.Out): Read = when (out) {
        is MraHttp.Out.NotReached -> NotReached
        is MraHttp.Out.NoAnswer -> NoAnswer
        is MraHttp.Out.Answered -> {
            val body = runCatching { json.parseToJsonElement(out.body) as? JsonObject }.getOrNull()
            if (body == null) {
                // not the MRA's answer: a gateway's page, or a server falling over after taking it
                if (out.http >= 500 || out.http == 0) NoAnswer else RefusedWhole(listOf("HTTP ${out.http}"), out.http == 401)
            } else {
                val t = MraApi.readTransmit(body)
                if (t.invoices.isNotEmpty()) Answered(t.invoices.associateBy { it.identifier }, t.responseId)
                else {
                    val errors = t.errors.ifEmpty { (body["errors"] as? JsonArray)?.map { it.toString().trim('"') } ?: listOf("${t.status} HTTP ${out.http}") }
                    RefusedWhole(errors, out.http == 401 || errors.any { it.contains("token", ignoreCase = true) })
                }
            }
        }
    }

    // a document's status once the MRA answered for it
    fun status(f: MraApi.Fiscal): String = if (f.status.equals("SUCCESS", ignoreCase = true)) "fiscalised" else "refused"
}
