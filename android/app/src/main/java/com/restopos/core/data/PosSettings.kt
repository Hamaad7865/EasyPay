package com.restopos.core.data

import com.restopos.core.print.Shop
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
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
) {
    fun shop(fallbackName: String): Shop =
        Shop(companyName.ifBlank { fallbackName }, address, phone, brn, vat, header, footer)

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

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
            )
        }
    }
}
