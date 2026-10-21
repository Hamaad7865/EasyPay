package com.restopos.core.mra

import com.restopos.core.data.Calc
import com.restopos.core.data.PosSettings
import com.restopos.core.data.RefundCalc
import com.restopos.core.database.DeviceEntity
import com.restopos.core.database.MraInvoiceEntity
import com.restopos.core.database.ReceiptLineEntity
import com.restopos.core.database.StoreEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.ApiClient
import javax.inject.Inject
import javax.inject.Singleton

// A sale or a refund of a Premium MRA client made into its invoice, before the
// transaction that records it (design section 8): its counter, number and
// hash are fixed here and the invoice is never built again. The caller writes
// `entity` and `device` (the till with its counter and chain moved on) in the
// same transaction as the receipt, and queues mra.record after receipt.create.
@Singleton
class MraIssuer @Inject constructor(private val db: TillDatabase, private val api: ApiClient) {
    sealed interface Prepared
    data object Skip : Prepared
    data class Refused(val why: String) : Prepared
    class Ready(val entity: MraInvoiceEntity, val device: DeviceEntity) : Prepared

    // A sale: its lines as the till charged them (Calc's base, add-ons in)
    // with the order discount and service charge the receipt has.
    suspend fun sale(
        settings: PosSettings, device: DeviceEntity, store: StoreEntity, receiptId: String, number: String, now: Long,
        lineIds: List<String>, totals: Calc.Totals, paid: List<Pair<String, Long>>, cashier: String?,
    ): Prepared {
        if (!settings.mraOn) return Skip
        val lines = lineIds.mapNotNull { saleLine(it, settings) }
        val plan = plan(settings, device, refund = false, ofTraining = false, number = number, now = now, refusal = MraLines.refusal(lines))
        if (plan !is MraIssue.Issue) return result(plan)
        val (items, left) = MraLines.ofSale(lines, totals.discount, totals.service)
        return ready(settings, device, store, receiptId, plan, now, items, left, MraLines.payment(paid), cashier, ref = "", reason = "")
    }

    // A refund: what comes back, line by line, as the till's refund worked it
    // out; a refund of the whole sale, the sale's own lines again.
    // origLines: the sale's receipt lines; back: order line id, how much comes
    // back and its part, or null when the receipt can only be refunded whole
    suspend fun refund(
        settings: PosSettings, device: DeviceEntity, store: StoreEntity, receiptId: String, number: String, now: Long,
        origId: String, origNumber: String, origDiscount: Long, origService: Long, origLines: List<ReceiptLineEntity>,
        back: List<Triple<String, Int, RefundCalc.Parts>>?, whole: Boolean, reason: String, paid: List<Pair<String, Long>>, cashier: String?,
    ): Prepared {
        if (!settings.mraOn) return Skip
        val orig = db.mra().byReceipt(origId)
        val plan = plan(settings, device, refund = true, ofTraining = orig?.type == "TRN", number = number, now = now, refusal = null)
        if (plan !is MraIssue.Issue) return result(plan)
        val (items, left) = if (whole || back == null) {
            MraLines.ofSale(origLines.map { lineOf(it, settings) }, origDiscount, origService)
        } else {
            MraLines.ofRefund(back.mapNotNull { (id, q, p) -> origLines.firstOrNull { it.ticket_line_id == id }?.let { Triple(lineOf(it, settings), q, p) } }) to 0L
        }
        val ref = if (plan.type == "CRN") orig?.identifier ?: origNumber else ""
        val why = if (plan.type == "CRN") reason.trim().ifEmpty { "Goods returned" } else ""
        return ready(settings, device, store, receiptId, plan, now, items, left, MraLines.payment(paid), cashier, ref, why)
    }

    private suspend fun plan(settings: PosSettings, device: DeviceEntity, refund: Boolean, ofTraining: Boolean, number: String, now: Long, refusal: String?) =
        MraIssue.plan(
            settings.mra, device.mra_ebs_id,
            // the till's own row has come from the server since this tablet was set up (PullApplier)
            restored = device.server_seq != null,
            refund = refund, refundOfTraining = ofTraining, number = number,
            counter = device.mra_counter, chain = device.mra_chain, lastIssuedAt = db.mra().latestIssuedAt(),
            clockAheadMs = api.clockAhead.value, now = now, refusal = refusal,
        )

    private fun result(p: MraIssue.Plan): Prepared = when (p) {
        is MraIssue.Refuse -> Refused(p.why)
        else -> Skip
    }

    private fun ready(
        settings: PosSettings, device: DeviceEntity, store: StoreEntity, receiptId: String, plan: MraIssue.Issue, now: Long,
        items: List<Line>, left: Long, payment: String, cashier: String?, ref: String, reason: String,
    ): Ready {
        val seller = Seller(
            name = settings.mraSeller.legalName,
            tradeName = settings.companyName.ifBlank { settings.mraSeller.legalName },
            tan = settings.mraSeller.tan,
            brn = settings.brn,
            businessAddr = store.address?.takeIf { it.isNotBlank() } ?: settings.address,
            businessPhoneNo = MraIssue.phone(settings.phone),
            vatRegistered = settings.vat.isNotBlank(),
        )
        val built = MraInvoice.build(MraInvoice.Input(
            counter = plan.counter, identifier = plan.identifier, type = plan.type, previous = plan.previous, issuedAt = now,
            seller = seller, lines = items, payment = payment, discount = left,
            counterNo = device.code.take(20), cashier = cashier.orEmpty().take(100), ref = ref, reason = reason,
        ))
        val entity = MraInvoiceEntity(
            id = receiptId, tenant_id = device.tenant_id, store_id = store.id, device_id = device.id, ebs_id = device.mra_ebs_id!!,
            receipt_id = receiptId, type = plan.type, counter = plan.counter, identifier = plan.identifier, ref_identifier = ref.ifEmpty { null },
            previous_hash = MraCrypto.previousNoteHash(plan.previous), invoice = built.text, issued_at = now,
        )
        return Ready(entity, device.copy(mra_counter = plan.counter, mra_chain = MraChain.with(device.mra_chain, plan.type, plan.counter, built.chained)))
    }

    // A line of a receipt: its order line when this tablet has it, else (another
    // till's sale, as the pull brought it) the receipt line itself.
    private suspend fun lineOf(rl: ReceiptLineEntity, settings: PosSettings): SaleLine {
        rl.ticket_line_id?.let { id -> saleLine(id, settings)?.let { return it } }
        val taxes = db.receipts().taxesOf(rl.id)
        val code = taxes.firstOrNull()?.let { t -> db.ops().allTaxes().firstOrNull { it.id == t.tax_id }?.mra_code }
        val nature = settings.mraSeller.nature.uppercase().takeIf { it == "GOODS" || it == "SERVICES" } ?: "GOODS"
        return SaleLine(
            name = rl.name_snapshot, addons = emptyList(), sku = null, qtyMilli = rl.qty,
            base = Calc.lineAmount(rl.unit_price, rl.qty) + db.receipts().modsOf(rl.id),
            taxes = taxes.map { Calc.TaxRate(it.rate_bp, it.type) }, mraCode = code, taxName = taxes.firstOrNull()?.name ?: "", nature = nature,
        )
    }

    // One order line as the MRA's: its name and add-ons, what it charged
    // before the order discount, its taxes with their MRA codes, goods or services.
    private suspend fun saleLine(lineId: String, settings: PosSettings): SaleLine? {
        val l = db.tickets().line(lineId) ?: return null
        val taxes = db.catalog().lineTaxes(lineId)
        val byId = db.ops().allTaxes().associateBy { it.id }
        val first = taxes.firstOrNull()?.let { byId[it.tax_id] }
        val item = l.item_id?.let { db.catalog().item(it) }
        val nature = (l.item_id?.let { db.ops().categoryOfItem(it)?.mra_nature } ?: settings.mraSeller.nature)
            .uppercase().takeIf { it == "GOODS" || it == "SERVICES" } ?: "GOODS"
        return SaleLine(
            name = l.name_snapshot, addons = db.tickets().lineMods(lineId).map { it.name_snapshot }, sku = item?.sku,
            qtyMilli = l.qty, base = Calc.lineAmount(l.unit_price, l.qty) + db.tickets().modSum(lineId),
            taxes = taxes.map { Calc.TaxRate(it.rate_bp, it.type) }, mraCode = first?.mra_code, taxName = first?.name ?: "", nature = nature,
        )
    }
}
