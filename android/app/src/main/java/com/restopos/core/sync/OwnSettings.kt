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
    val KINDS = listOf("company.save", "settings.save", "printer.save")

    // What those changes write, and so what the tablet keeps of its own.
    val KEYS = setOf("company", "receipt", "servicePct", "onePrinter")

    // The server's settings with the tablet's own values for KEYS put back
    // over them. A key the tablet does not have is the server's.
    fun kept(server: String, own: String?): String {
        val mine = read(own).filterKeys { it in KEYS }
        return if (mine.isEmpty()) server else JsonObject(read(server) + mine).toString()
    }

    private fun read(text: String?): JsonObject =
        runCatching { Json.parseToJsonElement(text ?: "{}").jsonObject }.getOrDefault(JsonObject(emptyMap()))
}
