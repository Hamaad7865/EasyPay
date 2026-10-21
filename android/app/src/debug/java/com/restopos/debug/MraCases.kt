package com.restopos.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.data.PosSettings
import com.restopos.core.database.MraInvoiceEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.mra.Line
import com.restopos.core.mra.MraChain
import com.restopos.core.mra.MraCrypto
import com.restopos.core.mra.MraInvoice
import com.restopos.core.mra.MraIssue
import com.restopos.core.mra.MraSender
import com.restopos.core.mra.Seller
import com.restopos.core.sync.SessionStore
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

// The MRA's Test Drive cases a till has no screen for (the phase 2 plan, Task
// 16; the owner's choice 12): a debit note (case 2), an invoice with a TAN
// that is not the seller's, which the MRA must refuse (case 5), and a pro
// forma (case 6). The debug build only: a real till never sends a wrong TAN.
// Each is issued as any document of this till is (its counter, its chain, a
// row in mra_invoices, a record for the server) and sent by the till's own
// MraSender. Cases 1, 3, 4 and 7 are made on the till's own screens.
//   adb shell am broadcast -n com.restopos.app/com.restopos.debug.MraCases -a com.restopos.app.MRA_CASE --es case case2
// What came of it is in logcat, tag MraCases: the status and the MRA's reasons, nothing else.
class MraCases : BroadcastReceiver() {
    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun db(): TillDatabase
        fun session(): SessionStore
        fun sender(): MraSender
    }

    override fun onReceive(context: Context, intent: Intent) {
        val which = intent.getStringExtra("case") ?: return Unit.also { Log.w(TAG, "say which: --es case case2 | case5 | case6") }
        val pending = goAsync()
        val deps = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
        CoroutineScope(Dispatchers.IO).launch {
            try {
                Log.i(TAG, run(deps, which))
            } catch (e: Exception) {
                Log.w(TAG, "$which not sent: ${e.message}")
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun run(deps: Deps, which: String): String {
        val db = deps.db()
        val settings = PosSettings.parse(db.ops().settings())
        require(settings.mraOn) { "this business is not in training or live with the MRA" }
        val device = deps.session().deviceId()?.let { db.catalog().device(it) } ?: error("this tablet is not set up as a till")
        val ebs = device.mra_ebs_id ?: error("this till has no EBS MRA ID")
        val store = db.catalog().store(device.store_id) ?: error("no store")
        // the MRA's test case 1's items: Chicken curry, Fried noodles (15 %), Milk (exempt)
        val curry = Line("Chicken curry", "TC1-A", "TC01", "GOODS", 1000, 11500, vatBp = 1500)
        val noodles = Line("Fried noodles", "TC1-B", "TC01", "GOODS", 1000, 23000, vatBp = 1500)
        val milk = Line("Milk", "TC1-E", "TC03", "GOODS", 1000, 4000)
        val lastStd = db.mra().lastOfType("STD")?.takeIf { it.status == "fiscalised" }
        val (type, lines) = when (which) {
            "case2" -> "DRN" to listOf(curry)
            "case5" -> "STD" to listOf(curry)
            "case6" -> "PRF" to listOf(noodles, milk)
            else -> error("unknown case $which: case2, case5 or case6")
        }
        if (type == "DRN") requireNotNull(lastStd) { "a debit note names an STD this till had fiscalised: make a sale first" }
        val counter = device.mra_counter + 1
        val now = System.currentTimeMillis()
        val identifier = "${store.code}-${device.code}-$type${counter.toString().padStart(6, '0')}"
        val previous = MraChain.last(device.mra_chain, type)?.second
        val tan = settings.mraSeller.tan
        val seller = Seller(
            settings.mraSeller.legalName, settings.companyName.ifBlank { settings.mraSeller.legalName },
            // case 5: any TAN but the seller's
            if (which == "case5") (if (tan == "12345678") "87654321" else "12345678") else tan,
            settings.brn, store.address?.takeIf { it.isNotBlank() } ?: settings.address, MraIssue.phone(settings.phone), settings.vat.isNotBlank(),
        )
        val built = MraInvoice.build(MraInvoice.Input(
            counter = counter, identifier = identifier, type = type, previous = previous, issuedAt = now, seller = seller, lines = lines,
            payment = "CASH", counterNo = device.code.take(20),
            ref = if (type == "DRN") lastStd!!.identifier else "", reason = if (type == "DRN") "Item served and left off the invoice" else "",
        ))
        val e = MraInvoiceEntity(
            Uuid7.next(), device.tenant_id, store.id, device.id, ebs, null, type, counter, identifier, if (type == "DRN") lastStd!!.identifier else null,
            MraCrypto.previousNoteHash(previous), built.text, now,
        )
        db.withTransaction {
            db.mra().insert(e)
            db.catalog().upsertDevices(listOf(device.copy(mra_counter = counter, mra_chain = MraChain.with(device.mra_chain, type, counter, built.chained))))
            db.outbox().enqueue(OutboxEntity(Uuid7.next(), "mra.record", MraIssue.record(e).toString()))
        }
        deps.sender().sendNow(15_000)
        val after = db.mra().byId(e.id)
        return "$which: $identifier ${after?.status}" + (after?.errors?.takeIf { it != "[]" }?.let { " $it" } ?: "")
    }

    private companion object {
        const val TAG = "MraCases"
    }
}
