package com.restopos.core.kitchen

import com.restopos.core.data.Routing
import com.restopos.core.database.KdsPartEntity
import com.restopos.core.database.KdsTicketEntity
import com.restopos.core.database.PrinterEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

// The till's side of a kitchen screen, as rules with nothing to do: what a
// send is as each screen's part of it, what a screen is still owed, when a
// kitchen ticket is done, how often to ask a screen, and what the cashier is
// told when one does not answer. ScreenLink does the work and asks here.
object Parts {
    // One send as each screen's part of it: the lines that go to that screen
    // (Routing.screenLines), with the ticket's head, written as it will be
    // sent and frozen. A later change to the menu or to what a screen shows
    // does not rewrite what the kitchen was told. A screen with nothing of
    // the send has no part.
    fun of(ticket: KdsTicketEntity, lines: List<Pair<WireLine, List<String>?>>, screens: List<PrinterEntity>, now: Long = System.currentTimeMillis()): List<KdsPartEntity> =
        Routing.screenLines(lines, screens).map { (screen, mine) ->
            KdsPartEntity(
                kds_id = ticket.id, screen_id = screen,
                payload = Wire.encodeTicket(WireTicket(ticket.id, ticket.no, ticket.label, ticket.kind, ticket.covers, ticket.waiter, ticket.remark, ticket.created_at, mine)),
                line_ids = buildJsonArray { mine.forEach { add(JsonPrimitive(it.id)) } }.toString(),
                created_at = now,
            )
        }

    // the order's lines a part holds
    fun lineIds(part: KdsPartEntity): List<String> =
        runCatching { Json.parseToJsonElement(part.line_ids).jsonArray.map { it.jsonPrimitive.content } }.getOrDefault(emptyList())

    // What an exchange puts: the parts the screen has not confirmed. One the
    // cooks have bumped is never sent again.
    fun toPut(open: List<KdsPartEntity>): List<KdsPartEntity> = open.filter { !it.delivered && it.bumped_at == null }

    // The parts a screen confirmed once and no longer holds (`have` is what
    // it says it holds): they are owed again.
    fun lost(open: List<KdsPartEntity>, have: Collection<String>): List<String> {
        val held = have.toSet()
        return open.filter { it.delivered && it.bumped_at == null && it.kds_id !in held }.map { it.kds_id }
    }

    // A kitchen ticket is done, and leaves the till's own Kitchen screen,
    // when it has parts and every screen has bumped its own. A ticket with no
    // part on any screen is not done by this rule: it is bumped on the till.
    fun ticketBumped(parts: List<KdsPartEntity>): Boolean = parts.isNotEmpty() && parts.all { it.bumped_at != null }

    // How long before the till asks a screen again. While orders are open on
    // it, soon, so a tick or a bump is on the till in a few seconds; with
    // nothing open, now and then, for a recall. A screen that does not
    // answer is asked less and less often, so a tablet that is switched off
    // costs the till nothing.
    fun pause(openParts: Int, failures: Int): Long = when {
        failures > 0 -> BACK_OFF.getOrElse(failures - 1) { IDLE }
        openParts > 0 -> BUSY
        else -> IDLE
    }

    // What is wrong with a screen, in words a cashier can act on; null when
    // nothing is. `reply` is what it answered, null when nothing did.
    fun trouble(name: String, address: String?, reply: WireReply?, waiting: Int): String? {
        val screen = called(name)
        if (Wire.address(address) == null) return "$screen has no address the till can use. Set it in the back office, under Printers."
        if (reply == null) {
            val owed = when (waiting) { 0 -> ""; 1 -> " 1 order is waiting for it."; else -> " $waiting orders are waiting for it." }
            return "$screen is not answering at ${address?.trim()}.$owed Check that the kitchen tablet is on, has EasyPay open and is on the same Wi-Fi."
        }
        if (reply.ok) return null
        return when (reply.error) {
            Wire.OTHER_VERSION ->
                if (reply.v > Wire.VERSION) "This till's EasyPay is too old for $screen. Update EasyPay on this till."
                else "The EasyPay on $screen's tablet is too old for this till. Update EasyPay on the kitchen tablet."
            else -> "$screen refused this till: the pairing code is not the one its tablet shows. Check the code in the back office, under Printers."
        }
    }

    // "Grill" is "Grill screen"; one already named "Kitchen screen" is left as it is
    fun called(name: String): String = if (name.trim().lowercase().endsWith("screen")) name.trim() else "${name.trim()} screen"

    private const val BUSY = 3_000L
    private const val IDLE = 15_000L
    private val BACK_OFF = listOf(3_000L, 5_000L, 10_000L)
}
