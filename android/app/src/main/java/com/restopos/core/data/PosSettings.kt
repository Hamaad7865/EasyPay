package com.restopos.core.data

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
) {
    fun shop(fallbackName: String): Shop =
        Shop(companyName.ifBlank { fallbackName }, address, phone, brn, vat, header, footer, bars = retail)

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
                setupOpen = d.str("setup") == "open",
                tableOrdering = d.bool("tableOrdering") ?: false,
                returns = if (d.str("businessType") != "retail") "refund" else d.str("returns")?.takeIf { it == "exchange" || it == "credit" || it == "refund" } ?: "exchange",
                returnDays = runCatching { d["returnDays"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 0..365 } ?: 7,
                noteMonths = runCatching { d["noteMonths"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 0..36 } ?: 6,
                slowMoverDays = runCatching { d["slowMoverDays"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 1..365 } ?: 30,
                promoStillDays = runCatching { d["promoStillDays"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 1..365 } ?: 14,
            )
        }
    }
}
