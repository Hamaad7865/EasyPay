package com.restopos.core.sync

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

// The settings of a tablet that worked on its own, at the moment it is
// connected. The business was made Premium on the server, which rewrote its
// settings there, so the first pull brings the server's copy: the plan, new,
// and everything else as it was the day the tablet was set up. What the
// tablet changed since is still in its queue. Until those changes have gone
// up the server's copy of them is the older one, and the tablet keeps its own.
// Once they have, the server's copy is the tablet's, and it is taken whole.
object OwnSettings {
    // The kept changes that write into the settings (LocalAnswers): the
    // business's details, the receipt's notes and the service charge, and
    // the one-printer switch.
    // Which of them writes what.
    val WRITES = mapOf(
        "company.save" to setOf("company"),
        "settings.save" to setOf("receipt", "servicePct", "deposits", "depositCancel", "depositDays", "depositOverdue", "depositGrace", "depositCustomer", "accounts", "accountDays", "loyalty", "loyaltyBp"),
        "printer.save" to setOf("onePrinter"),
    )
    val KINDS = WRITES.keys.toList()

    // What those changes write, and so what the tablet keeps of its own.
    val KEYS = WRITES.values.flatten().toSet()

    // The server's settings with the tablet's own values put back over them,
    // for what the kept changes still waiting (`waiting`, their kinds) write.
    // A key the tablet does not have is the server's, and so is what no
    // waiting change wrote: a tablet that only added a printer on its own
    // still takes the receipt's notes EasyPay set up for it since ("Get
    // changes from EasyPay", Fetched). Until that was told apart, one kept
    // change of any of the three held back all four keys, for as long as the
    // tablet worked on its own.
    fun kept(server: String, own: String?, waiting: Collection<String> = KINDS): String {
        val keys = waiting.flatMap { WRITES[it].orEmpty() }.toSet()
        val mine = read(own).filterKeys { it in keys }
        return if (mine.isEmpty()) server else JsonObject(read(server) + mine).toString()
    }

    private fun read(text: String?): JsonObject =
        runCatching { Json.parseToJsonElement(text ?: "{}").jsonObject }.getOrDefault(JsonObject(emptyMap()))
}
