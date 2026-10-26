package com.restopos.core.data

import com.restopos.core.database.StoreEntity
import com.restopos.core.print.Shop
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// The restaurant's settings, as saved in the back office (POS settings,
// Company details, Receipt design). A key that is missing means "as before",
// so a till that has not synced yet behaves the way it always did.
data class PosSettings(
    val decimals: Int = 2,
    val billReset: Boolean = false, // bill numbers start again after each day closing
    val dayCloseDetailed: Boolean = true,
    val header: String = "",
    val footer: String = "Thank you. See you again soon.",
    val logo: String? = null, // data:image/png;base64,...
    val showLogo: Boolean = true,
    val companyName: String = "",
    val brn: String = "",
    val vat: String = "",
    val address: String = "",
    val phone: String = "",
    val quickPay: String = "card", // what the register's quick payment key takes: card or cash
    val servicePct: Int = 0, // a service charge on orders served at a table, in percent; 0 is none
    val kitchenNotes: List<String> = DEFAULT_NOTES, // the notes offered when an item is added
    val prepMinutes: Int = 15, // how long after it is rung up a takeaway is due
    val lockMinutes: Int = 0, // minutes without a touch before the till locks itself; 0 is never
    val kitchenSound: Boolean = true, // a short sound on the kitchen display when an order arrives
    // one printer does everything: kitchen orders print on the receipt printer, whatever the categories say
    val onePrinter: Boolean = false,
    // the drawer is counted note by note and coin by coin, in place of typing the amount
    val drawerByNotes: Boolean = false,
    // the business is a shop: the till shows the sell screen, not tables and a kitchen
    val retail: Boolean = false,
    // The restaurant's plan carries the premium screens: the kitchen display
    // and bookings (server 0085). True when the settings name no plan, as for
    // every key here: a till whose server has not been told about plans yet
    // goes on showing what it showed.
    val premium: Boolean = true,
    // The business is on the offline plan: this tablet works on its own. It
    // does not sync, answers by itself what a linked till asks the server
    // for, and keeps every change in its queue for the day the business goes
    // Premium (docs/superpowers/specs/2026-10-11-tablet-alone-design.md).
    val alone: Boolean = false,
    // The settings name the plan premium or trial: the business is in the
    // cloud. Unlike premium, no plan at all is not taken for it: it ends a
    // tablet's setting up (SettingUp), which no missing word should do.
    val cloud: Boolean = false,
    // The business's first-run set-up is still open (server 0089): a tablet
    // named for it is walked through the set-up. Only a client made since
    // carries the mark; with none, as for every key here, nothing changes.
    val setupOpen: Boolean = false,
    // Guests order from the code on their table (the back office's POS
    // settings; core/guest). Off unless the settings say so, and the till
    // listens only when the plan carries it and the business is a restaurant.
    val tableOrdering: Boolean = false,
    // A shop's return policy (server 0109): exchange (no money back), credit
    // (an exchange's rest goes on a credit note) or refund. Days inside which
    // whoever is at the till returns alone (0: the right to refund is always
    // needed), and months a note is valid (0: never expires). A restaurant
    // refunds as it always did.
    val returns: String = "exchange",
    val returnDays: Int = 7,
    val noteMonths: Int = 6,
    // A shop's promotions (server 0110): days without a sale that make a
    // product a slow mover, and days a promotion may sit unsold before it
    // is flagged to be reduced again.
    val slowMoverDays: Int = 30,
    val promoStillDays: Int = 14,
    // Minutes before an order for later is due that the till rings
    // (DueReminder, server 0111). 0, and a missing key, is off.
    val dueReminder: Int = 0,
    // How the receipt and the kitchen ticket are laid out, from the back
    // office's Receipt design: the `papers` key as it came, read when a paper
    // is printed (core/print/Papers). Null, EasyPay's own.
    val papers: String? = null,
    // A shop's deposits (server 0113). Paid for: the plan carries them
    // (premium, trial) or the platform admin switched them on (features).
    // A missing plan does NOT count here, unlike premium: a till that has not
    // been told shows nothing. The shop may turn them off; what happens when
    // one is cancelled (refund, credit, keep); the collect-by date offered;
    // past it whether one is only marked or cancelled after the grace days;
    // whether a customer's name and phone are asked.
    val depositsPaid: Boolean = false,
    val depositsOn: Boolean = true,
    val depositCancel: String = "credit",
    val depositDays: Int = 30,
    val depositOverdue: String = "show",
    val depositGrace: Int = 7,
    val depositCustomer: Boolean = true,
    // A shop's customer accounts (server 0114): paid for as deposits are.
    // accountDays: a bill is overdue after that many days.
    val accountsPaid: Boolean = false,
    val accountsOn: Boolean = true,
    val accountDays: Int = 30,
    // Loyalty points (server 0128), for every business on every plan: off
    // until switched on; loyaltyBp is what comes back, in basis points (100 is 1%).
    val loyalty: Boolean = false,
    val loyaltyBp: Int = 100,
    // The time each till closes a day nobody closed (server 0133), on the
    // tablet's clock; null, and a missing key, is off.
    val autoClose: java.time.LocalTime? = null,
    // MRA e-invoicing (server 0116, 0132): where the business stands (off,
    // setting_up, training, live; a missing key is off), the seller's details
    // its invoices carry, and the MRA's address and public key, typed once in
    // /admin for every client.
    val mra: String = "off",
    val mraSeller: MraSeller = MraSeller(),
    val mraConnect: MraConnect? = null,
) {
    data class MraSeller(val legalName: String = "", val tan: String = "", val nature: String = "")
    data class MraConnect(val url: String, val certificate: String)

    // the tills send to the MRA: training invoices, or real ones
    val mraOn: Boolean get() = mra == "training" || mra == "live"

    // a shop that may take deposits now
    val deposits: Boolean get() = retail && depositsPaid && depositsOn

    // a shop that may sell on account now
    val accounts: Boolean get() = retail && accountsPaid && accountsOn

    // `store`: this till's branch; `many`: the account has two or more (multi-branch). Then a paper names the
    // branch and gives its own address and phone, the company's where it has none. With one branch, as before.
    fun shop(fallbackName: String, store: StoreEntity? = null, many: Boolean = false): Shop {
        val branch = store?.takeIf { many }
        return Shop(
            companyName.ifBlank { fallbackName },
            branch?.address?.takeIf { it.isNotBlank() } ?: address,
            branch?.phone?.takeIf { it.isNotBlank() } ?: phone,
            brn, vat, header, footer, bars = retail, branch = branch?.name.orEmpty(),
        )
    }

    companion object {
        val DEFAULT_NOTES = listOf("No onion", "Less salt", "Nut allergy", "Extra chutney", "Rush")
        private val json = Json { ignoreUnknownKeys = true }

        // the plan on which a tablet works on its own
        fun isAlone(plan: String?): Boolean = plan?.trim()?.lowercase() == "offline"

        fun parse(text: String?): PosSettings {
            val d = runCatching { json.parseToJsonElement(text ?: "{}").jsonObject }.getOrNull() ?: return PosSettings()
            fun obj(k: String): JsonObject? = runCatching { d[k]?.jsonObject }.getOrNull()
            fun JsonObject?.str(k: String): String? = runCatching { this?.get(k)?.jsonPrimitive?.contentOrNull }.getOrNull()
            fun JsonObject?.bool(k: String): Boolean? = runCatching { this?.get(k)?.jsonPrimitive?.booleanOrNull }.getOrNull()
            val r = obj("receipt")
            val c = obj("company")
            val def = PosSettings()
            return PosSettings(
                decimals = runCatching { d["decimals"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 0..2 } ?: 2,
                billReset = d.str("billNumbering") == "reset",
                dayCloseDetailed = d.bool("dayCloseDetailed") ?: true,
                header = r.str("header") ?: "",
                footer = r.str("footer") ?: def.footer,
                logo = r.str("logo")?.takeIf { it.startsWith("data:image/") },
                showLogo = r.bool("showLogo") ?: true,
                companyName = c.str("name") ?: "",
                brn = c.str("brn") ?: "",
                vat = c.str("vat") ?: "",
                address = c.str("address") ?: "",
                phone = c.str("phone") ?: "",
                quickPay = d.str("quickPay")?.takeIf { it == "cash" || it == "card" } ?: "card",
                servicePct = runCatching { d["servicePct"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 0..30 } ?: 0,
                // a list that was saved is the list, an empty one included: only a restaurant that never saved one is offered the usual five
                kitchenNotes = runCatching { d["kitchenNotes"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull?.trim()?.takeIf { n -> n.isNotEmpty() } } }
                    .getOrNull()?.take(12) ?: DEFAULT_NOTES,
                prepMinutes = runCatching { d["prepMinutes"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 1..180 } ?: 15,
                lockMinutes = runCatching { d["lockMinutes"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 0..120 } ?: 0,
                kitchenSound = d.bool("kitchenSound") ?: true,
                onePrinter = d.bool("onePrinter") ?: false,
                drawerByNotes = d.bool("drawerByNotes") ?: false,
                retail = d.str("businessType") == "retail",
                // as the server reads it (has_premium): premium, and trial so that a restaurant trying EasyPay sees all of it
                premium = d.str("plan")?.trim()?.lowercase()?.let { it == "premium" || it == "trial" } ?: true,
                alone = isAlone(d.str("plan")),
                cloud = d.str("plan")?.trim()?.lowercase().let { it == "premium" || it == "trial" },
                setupOpen = d.str("setup") == "open",
                tableOrdering = d.bool("tableOrdering") ?: false,
                returns = if (d.str("businessType") != "retail") "refund" else d.str("returns")?.takeIf { it == "exchange" || it == "credit" || it == "refund" } ?: "exchange",
                returnDays = runCatching { d["returnDays"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 0..365 } ?: 7,
                noteMonths = runCatching { d["noteMonths"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 0..36 } ?: 6,
                slowMoverDays = runCatching { d["slowMoverDays"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 1..365 } ?: 30,
                promoStillDays = runCatching { d["promoStillDays"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 1..365 } ?: 14,
                dueReminder = runCatching { d["dueReminderMinutes"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 1..120 } ?: 0,
                papers = obj("papers")?.toString(),
                depositsPaid = d.str("plan")?.trim()?.lowercase().let { it == "premium" || it == "trial" } ||
                    runCatching { d["features"]?.jsonArray?.any { it.jsonPrimitive.contentOrNull == "deposits" } }.getOrNull() == true,
                depositsOn = d.str("deposits") != "off",
                depositCancel = d.str("depositCancel")?.takeIf { it == "refund" || it == "credit" || it == "keep" } ?: "credit",
                depositDays = runCatching { d["depositDays"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 1..365 } ?: 30,
                depositOverdue = d.str("depositOverdue")?.takeIf { it == "show" || it == "cancel" } ?: "show",
                depositGrace = runCatching { d["depositGrace"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 0..365 } ?: 7,
                depositCustomer = d.str("depositCustomer") != "optional",
                accountsPaid = d.str("plan")?.trim()?.lowercase().let { it == "premium" || it == "trial" } ||
                    runCatching { d["features"]?.jsonArray?.any { it.jsonPrimitive.contentOrNull == "accounts" } }.getOrNull() == true,
                accountsOn = d.str("accounts") != "off",
                accountDays = runCatching { d["accountDays"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 1..365 } ?: 30,
                loyalty = d.str("loyalty") == "on",
                loyaltyBp = runCatching { d["loyaltyBp"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 1..10000 } ?: 100,
                autoClose = AutoCloseRules.parse(d.str("autoClose")),
                mra =d.str("mra")?.takeIf { it in setOf("off", "setting_up", "training", "live") } ?: "off",
                mraSeller = obj("mra_seller").let { m -> MraSeller(m.str("legal_name") ?: "", m.str("tan") ?: "", m.str("nature") ?: "") },
                mraConnect = obj("mra_connect")?.let { m ->
                    val url = m.str("url"); val cert = m.str("certificate")
                    if (url.isNullOrBlank() || cert.isNullOrBlank()) null else MraConnect(url, cert)
                },
            )
        }
    }
}
