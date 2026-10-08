package com.restopos.core.kitchen

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

// What a till and a kitchen screen say to each other over the restaurant's
// own Wi-Fi. The till opens a short connection to the screen's address, as it
// does to a printer, writes one request and reads one reply:
//
//   till    -> screen   <the request, one line of JSON>\n<its signature>\n
//   screen  -> till     <the reply, one line of JSON>\n
//
// Nothing here knows about Android, sockets or the database: the two ends
// (ScreenBook on the kitchen tablet, ScreenLink on the till) and the tests
// share it as it stands.

// One line of an order as the kitchen reads it: how many, what, and what was
// asked for with it (add-ons and the kitchen note).
@Serializable
data class WireLine(val id: String, val qty: Int, val name: String, val detail: String = "")

// One screen's part of one send: what the cooks at that screen are to make.
// `id` is the kitchen ticket's, `no` its number of the day (K-numbers count
// per till), `label` the table or the order's number.
@Serializable
data class WireTicket(
    val id: String, val no: Int, val label: String, val kind: String, val covers: Int? = null,
    val waiter: String? = null, val remark: String? = null, val sentAt: Long, val lines: List<WireLine>,
)

// What a thing is now, never "flip it": the same mark twice changes nothing,
// so a message that is sent again does no harm. Exactly one of `line` and
// `ticket` is set. From the till: a line voided, a line done or not done, a
// ticket bumped or recalled on the till's own Kitchen screen. From the
// screen: a line done or not done, its part of a ticket bumped or recalled.
@Serializable
data class WireMark(
    val line: String? = null, val ticket: String? = null,
    val done: Boolean? = null, val voided: Boolean? = null, val bumped: Boolean? = null,
)

// `screen` is the screen's name in the back office, for its header. `put` is
// the tickets the screen has not confirmed yet; `after` the number of the
// last of the cooks' changes this till has taken. `now` is the till's own
// clock as it asks: with a ticket's `sentAt`, off the same clock, it says how
// long the ticket has already waited (a screen that was switched off gets its
// orders late), whatever the two tablets' clocks say of each other.
@Serializable
data class WireRequest(
    val v: Int = Wire.VERSION, val till: String, val tillName: String, val tillCode: String, val screen: String,
    val put: List<WireTicket> = emptyList(), val marks: List<WireMark> = emptyList(), val after: Long = 0, val now: Long = 0,
)

// `error` when not ok: "refused" (not signed with this screen's code), or
// "version" (the two ends speak different versions of this; `v` and `build`
// say which one to update). `epoch` is made when the tablet is set up as a
// kitchen screen: a new one means it holds nothing it was sent before.
// `marks` is what the cooks did since `after`, `seq` the number of the last
// of them, `have` the ids of this till's tickets the screen holds.
@Serializable
data class WireReply(
    val ok: Boolean, val error: String? = null, val v: Int = Wire.VERSION, val build: Int = 0, val epoch: String = "",
    val seq: Long = 0, val marks: List<WireMark> = emptyList(), val have: List<String> = emptyList(),
)

object Wire {
    const val VERSION = 1
    // the port a kitchen screen listens on, unless its address names another
    const val PORT = 9310
    const val REFUSED = "refused"
    const val OTHER_VERSION = "version"

    // Defaults are written out, so the other end never has to guess them; a
    // key it does not know is read past, so a newer build can say more.
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    // HMAC-SHA256 of the line, keyed with the pairing code, as lower-case hex.
    // The code itself is never sent over the Wi-Fi.
    fun sign(code: String, line: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(code.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(line.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    fun encode(req: WireRequest, code: String): String {
        val line = json.encodeToString(WireRequest.serializer(), req)
        return line + "\n" + sign(code, line) + "\n"
    }

    // The request, or null when it was not signed with this code, was changed
    // on the way, or is not a request at all. Nothing is said about which:
    // the screen answers "refused" to all three.
    fun decode(first: String, second: String, code: String): WireRequest? {
        val want = sign(code, first).toByteArray(Charsets.UTF_8)
        if (!MessageDigest.isEqual(want, second.trim().toByteArray(Charsets.UTF_8))) return null
        return runCatching { json.decodeFromString(WireRequest.serializer(), first) }.getOrNull()
    }

    fun encode(reply: WireReply): String = json.encodeToString(WireReply.serializer(), reply) + "\n"

    fun decodeReply(line: String): WireReply? = runCatching { json.decodeFromString(WireReply.serializer(), line) }.getOrNull()

    // A ticket and a mark as text, for the till to keep until a screen has them.
    fun encodeTicket(ticket: WireTicket): String = json.encodeToString(WireTicket.serializer(), ticket)
    fun decodeTicket(text: String): WireTicket? = runCatching { json.decodeFromString(WireTicket.serializer(), text) }.getOrNull()
    fun encodeMark(mark: WireMark): String = json.encodeToString(WireMark.serializer(), mark)
    fun decodeMark(text: String): WireMark? = runCatching { json.decodeFromString(WireMark.serializer(), text) }.getOrNull()

    // A screen's address as the back office keeps it: an IP, or IP:port.
    fun address(text: String?): Pair<String, Int>? {
        val t = text?.trim().orEmpty()
        if (t.isEmpty()) return null
        if (!t.contains(':')) return t to PORT
        val host = t.substringBefore(':')
        val port = t.substringAfter(':').toIntOrNull() ?: return null
        return if (host.isEmpty() || port !in 1..65535) null else host to port
    }
}
