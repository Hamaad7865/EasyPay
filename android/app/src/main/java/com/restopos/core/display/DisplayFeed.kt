package com.restopos.core.display

import com.restopos.core.common.tableLabel
import com.restopos.core.data.PosSettings
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.TicketEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import javax.inject.Inject
import javax.inject.Singleton

// The till's side of its customer displays: what they should show now,
// worked out from the till's own database every time it is asked, so it is
// always what the order on the register is, whichever screen changed it (the
// order, a shop's Sell, Pay). The rules are in Pictures, and tested there.
//
//   - the order on the register, with lines: its picture
//   - a sale just paid (Pay says so): the change, for 20 seconds, or until
//     an item is rung up on the next sale
//   - otherwise: the idle screen
@OptIn(ExperimentalCoroutinesApi::class)
@Singleton
class DisplayFeed @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val tickets: TicketRepository,
    private val service: ServiceRepository,
) {
    // the paid picture, and until when it stays
    private val held = MutableStateFlow<Pair<Picture, Long>?>(null)
    // the last picture of the sale on the register, which the paid picture keeps
    @Volatile private var lastSale: Picture? = null

    // Something the displays show may have changed: the order on the
    // register, its lines, its discount, or a sale paid. The link sends the
    // picture again at once; it also sends it every few seconds whatever.
    val changes: Flow<Unit> = merge(
        session.activeTicketFlow.flatMapLatest { id -> if (id == null) flowOf(Unit) else db.tickets().lines(id).map { } },
        session.pendingDiscountFlow.map { },
        held.map { },
    )

    // What a screen on a cable shows, as it changes: the picture of now at
    // once on every change, and every second besides (the change after Pay
    // goes back to idle by the clock).
    fun live(): Flow<Picture> = channelFlow {
        launch { changes.collect { send(now()) } }
        while (true) {
            send(now())
            delay(1000)
        }
    }.distinctUntilChanged()

    // the business's logo (a data URL, as on the receipts), for a cable screen; a Wi-Fi display is sent it
    val logo: Flow<String?> = db.ops().settingsFlow().map { PosSettings.parse(it).logo }.distinctUntilChanged()

    // Pay: a sale has just been paid in full.
    fun paid(total: Long, change: Long, at: Long = System.currentTimeMillis()) {
        held.value = Pictures.paid(total, change, lastSale) to at + HOLD_MS
    }

    suspend fun now(at: Long = System.currentTimeMillis()): Picture {
        val settings = PosSettings.parse(db.ops().settings())
        // The till's language as it keeps it, never L's: this runs off the
        // main thread, and a Compose state first made here is one the till's
        // screen cannot read.
        val lang = session.lang.first()
        val base = Picture(lang = lang, decimals = settings.decimals, business = settings.companyName.ifBlank { session.businessName().orEmpty() })
        val sale = sale(base)
        if (sale != null) lastSale = sale
        val paid = held.value
        if (paid != null && sale == null && at < paid.second) {
            return paid.first.copy(lang = base.lang, decimals = base.decimals, business = base.business)
        }
        if (paid != null) held.value = null
        return sale ?: Pictures.idleOf(base)
    }

    private suspend fun sale(base: Picture): Picture? {
        val t = tickets.activeTicket() ?: return null
        val lines = service.describe(db.tickets().lines(t.id).first())
        if (lines.isEmpty()) return null
        val discount = tickets.pendingDiscount()
        val pct = service.servicePct(t)
        val due = service.dueOf(lines, pct, discount)
        val included = service.vatIncluded(lines, pct, discount)
        val paid = db.receipts().paidForTicket(t.id)
        val rung = lines.map { Pictures.Rung(it.line.qty, it.line.name_snapshot, it.detail, it.amount, it.line.unit_price, it.line.list_price) }
        return Pictures.sale(title(t, base.lang), rung, due, included, discount?.name, pct, paid, words(base.lang), base)
    }

    // "Table 4", "Takeaway A-12", "Quick sale C-3"
    private suspend fun title(t: TicketEntity, lang: String): String {
        t.table_id?.let { db.tables().table(it) }?.let { return tableLabel(it.name) }
        val type = t.dining_option_id?.let { id -> db.catalog().diningOptions().firstOrNull { it.id == id } }
        val name = if (type == null || type.kind == "counter") say(lang, "Quick sale", "Vente rapide", "Lavant rapid") else type.name
        return listOfNotNull(name, t.order_no).joinToString(" ")
    }

    private fun words(lang: String) = Pictures.Words(
        subtotal = say(lang, "Subtotal", "Sous-total", "Sou-total"),
        service = say(lang, "Service", "Service", "Servis"),
        vatIncluded = say(lang, "VAT included", "TVA incluse", "TVA inkli"),
        vat = say(lang, "VAT", "TVA", "TVA"),
        rounding = say(lang, "Rounding", "Arrondi", "Larondisman"),
    )

    // L.t, for a language given rather than L's own
    private fun say(lang: String, en: String, fr: String, kreol: String): String = when (lang) { "fr" -> fr; "mfe" -> kreol; else -> en }

    companion object {
        const val HOLD_MS = 20_000L
    }
}
