package com.restopos.core.print

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray

// Every label a shop can print on: the ready-made ones, then the ones it
// designed itself. Its own are kept on the tablet as text (SessionStore) and
// nowhere else, so reading them is forgiving: one that cannot be read is left
// out and the others stay. Whoever needs a label asks here, so that a label
// of the shop's own is found wherever a ready-made one is.
object LabelBook {
    // how the id of one of the shop's own labels begins; a ready-made label's never does
    const val OWN = "own-"
    private val json = Json { ignoreUnknownKeys = true }

    fun isOwn(id: String): Boolean = id.startsWith(OWN)

    fun read(text: String?): List<LabelTemplate> {
        if (text.isNullOrBlank()) return emptyList()
        val rows = runCatching { json.parseToJsonElement(text).jsonArray }.getOrNull() ?: return emptyList()
        return rows.mapNotNull { runCatching { json.decodeFromJsonElement(LabelTemplate.serializer(), it) }.getOrNull() }
            .filter { isOwn(it.id) }
            .distinctBy { it.id }
    }

    fun write(own: List<LabelTemplate>): String = json.encodeToString(kotlinx.serialization.builtins.ListSerializer(LabelTemplate.serializer()), own)

    // saved: a new label goes last, one saved again takes the place it had
    fun with(own: List<LabelTemplate>, t: LabelTemplate): List<LabelTemplate> =
        if (own.any { it.id == t.id }) own.map { if (it.id == t.id) t else it } else own + t

    fun without(own: List<LabelTemplate>, id: String): List<LabelTemplate> = own.filter { it.id != id }

    fun all(own: List<LabelTemplate>): List<LabelTemplate> = LabelTemplates.all + own

    // The label of that id, or null when there is none any more: a label that
    // was deleted must not quietly turn into another one.
    fun find(own: List<LabelTemplate>, id: String?): LabelTemplate? = all(own).firstOrNull { it.id == id }
}
