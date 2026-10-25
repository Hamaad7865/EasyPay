package com.restopos.core.data

import com.restopos.core.print.PagePart
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The Z report by email (docs/superpowers/specs/2026-10-25-z-report-email-design.md):
// what a till keeps of the setting, and what each answer of EasyPay's mail
// service (cloudflare/mail) does to it. Nothing here sends or reads anything:
// ZMail does.
//
// The setting is the till's own, kept with what the tablet knows of itself
// (SessionStore), not in the business's settings: each till closes its own day
// and mails its own Z, nothing of it goes to the server, and no fetch can put
// it back. It goes into a backup, and goes at sign-out.
@Serializable
data class ZMailSetting(
    val on: Boolean = false,
    // the address as the owner typed it; kept when switched off, to show it again
    val to: String = "",
    // The till's own key for that address: 64 hexadecimal characters made here
    // when the address was typed. The service keeps only its hash, and takes a
    // report for the address only with it.
    val key: String = "",
    // closings after this moment are mailed; it moves on with each one that is
    val after: Long = 0,
    val state: String = ZMailRules.ASK,
    // the service's words, when it refused the address or said to wait
    val said: String? = null,
    // when the address was mailed to confirm
    val asked: Long? = null,
    // the last closing mailed: its number, and when
    val sentNo: Int? = null,
    val sentAt: Long? = null,
    // an address and key the service has still to forget: switched off, or another address typed
    val forget: List<ZMailForget> = emptyList(),
)

@Serializable
data class ZMailForget(val to: String, val key: String)

object ZMailRules {
    const val ASK = "ask" // the address is to be mailed to confirm, when the tablet is online
    const val WAITING = "waiting" // it was, and nobody has pressed Confirm yet
    const val YES = "yes" // confirmed: each closing is mailed
    const val EXPIRED = "none" // nobody pressed Confirm within the week the link lasts
    const val STOPPED = "stopped" // the address asked for no more (the link at a report's foot)
    const val REFUSED = "refused" // the address is not taken, or Cloudflare will not mail it

    // a closing older than this is not mailed: a tablet a month offline sends its last month
    const val OLDEST_MS = 31L * 86_400_000
    // closings mailed in one go; the next run takes the rest
    const val BATCH = 5

    private val json = Json { ignoreUnknownKeys = true }
    fun read(text: String?): ZMailSetting = text?.let { runCatching { json.decodeFromString(ZMailSetting.serializer(), it) }.getOrNull() } ?: ZMailSetting()
    fun write(s: ZMailSetting): String = json.encodeToString(ZMailSetting.serializer(), s)

    // An address as the service takes it, in small letters, or null. The same
    // rule as the service's (cloudflare/mail/src/rules.js, addressOf).
    fun address(raw: String): String? {
        val a = raw.trim().lowercase()
        if (a.length > 254) return null
        val m = ADDRESS.matchEntire(a) ?: return null
        val local = m.groupValues[1]
        if (local.startsWith(".") || local.endsWith(".") || ".." in local) return null
        return a
    }
    private val ADDRESS = Regex("""([^\s@<>()\[\]\\,;:"']{1,64})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63})""")

    fun key(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xFF) }

    // The setting as saved from Settings. Switched off: nothing more is sent,
    // and the service is to forget the address for this till. Switched on, or
    // another address typed: a new key, and the address is to be asked; the
    // closings mailed are those after the moment it was switched on (another
    // address takes over the ones still waiting). The same address saved again
    // changes nothing.
    fun saved(old: ZMailSetting, on: Boolean, typed: String, now: Long, newKey: () -> String): ZMailSetting {
        val to = typed.trim()
        if (!on) return old.copy(on = false, to = to, key = "", state = ASK, said = null, asked = null, forget = forgetting(old))
        if (old.on && old.key.isNotEmpty() && address(old.to) == address(to)) return old.copy(to = to)
        return old.copy(
            on = true, to = to, key = newKey(), after = if (old.on) old.after else now,
            state = ASK, said = null, asked = null, sentNo = null, sentAt = null, forget = forgetting(old),
        )
    }
    private fun forgetting(old: ZMailSetting) = if (old.on && old.key.isNotEmpty()) (old.forget + ZMailForget(old.to, old.key)).takeLast(5) else old.forget

    // "Send it again": the address is mailed to confirm once more.
    fun again(s: ZMailSetting): ZMailSetting = if (s.on) s.copy(state = ASK, said = null) else s

    // Whether an answer is for the setting as it still is: the owner may have
    // switched it off or typed another address while the tablet was asking.
    fun stillFor(now: ZMailSetting, asked: ZMailSetting): Boolean = now.on && now.key == asked.key

    // What the service answered. No answer at all (no connection, or the
    // service is not up) is null: try again later.
    data class Answer(val status: Int, val state: String? = null, val error: String? = null, val code: String? = null, val sent: Boolean = false)

    // An answer that means "later": the run stops here and is tried again.
    fun later(a: Answer?): Boolean = a == null || a.status == 409 || a.status == 429 || a.status >= 500

    // after asking the service to mail the address to confirm
    fun asked(s: ZMailSetting, a: Answer, now: Long): ZMailSetting = when {
        a.status == 200 && a.state == "yes" -> s.copy(state = YES, said = null)
        a.status == 200 -> s.copy(state = WAITING, said = null, asked = now)
        a.status == 429 -> s.copy(said = a.error) // still to be asked, tomorrow
        a.status in 400..499 -> s.copy(state = REFUSED, said = a.error)
        // the service could not send it now (Cloudflare's limits, or its own fault): tried again, and why is said
        else -> s.copy(said = a.error ?: s.said)
    }

    // after asking whether the address has confirmed
    fun checked(s: ZMailSetting, a: Answer): ZMailSetting = if (a.status != 200) s else when (a.state) {
        "yes" -> s.copy(state = YES, said = null)
        "none" -> s.copy(state = EXPIRED)
        else -> s
    }

    // after sending one closing
    fun mailed(s: ZMailSetting, closedAt: Long, number: Int, now: Long, a: Answer): ZMailSetting = when {
        a.status == 200 && a.sent -> s.copy(after = maxOf(s.after, closedAt), sentNo = number, sentAt = now, said = null)
        // not confirmed after all; or confirmed and then stopped, with the link at a report's foot
        a.status == 403 && a.state == "waiting" -> s.copy(state = WAITING)
        a.status == 403 -> s.copy(state = if (s.state == YES) STOPPED else EXPIRED)
        a.status == 422 -> s.copy(state = REFUSED, said = a.error)
        a.status == 429 -> s.copy(said = a.error)
        // being sent by a request still going: tried again, never passed over
        a.status == 409 -> s
        // the service could not read this closing, and never will: it is passed over
        a.status in 400..499 -> s.copy(after = maxOf(s.after, closedAt), said = a.error)
        // the service could not send it now: tried again, and why is said
        else -> s.copy(said = a.error ?: s.said)
    }

    // A paper's parts as the mail service reads them (cloudflare/mail/src/report.js,
    // readParts): k the kind, l and r the two sides, b bold, s the size; what is
    // as usual is left out. cloudflare/mail/test/z-parts.json is an example.
    fun partsJson(parts: List<PagePart>): JsonArray = JsonArray(parts.map { p ->
        buildJsonObject {
            put("k", p.kind)
            if (p.left.isNotEmpty()) put("l", p.left)
            if (p.right.isNotEmpty()) put("r", p.right)
            if (p.bold) put("b", true)
            if (p.size != "normal") put("s", p.size)
        }
    })

    // From when the closings still to mail are looked for.
    fun from(s: ZMailSetting, now: Long): Long = maxOf(s.after, now - OLDEST_MS)

    // What Settings says of the setting, and whether it offers to mail the address to confirm again.
    data class Words(val text: String, val again: Boolean = false)

    fun words(s: ZMailSetting, waiting: Int, stamp: (Long) -> String): Words {
        val to = s.to
        val left = if (waiting > 0) " $waiting ${if (waiting == 1) "closing waits" else "closings wait"} to go when the tablet is online." else ""
        return when (s.state) {
            ASK -> Words("The email to confirm goes to $to as soon as the tablet is online." + (s.said?.let { " The mail service said: $it." } ?: ""))
            WAITING -> Words("An email was sent to $to${s.asked?.let { " at ${stamp(it)}" } ?: ""}: press Confirm in it. Day closings wait here until then and go once it is pressed.", again = true)
            YES -> Words("Each day closing of this till is emailed to $to." + (s.sentNo?.let { n -> " The last one, no. $n, went at ${s.sentAt?.let(stamp) ?: ""}." } ?: "") + left + (s.said?.let { " The mail service said: $it." } ?: ""))
            EXPIRED -> Words("Nobody pressed Confirm in the email to $to within a week.", again = true)
            STOPPED -> Words("$to asked for no more of these emails, with the link at the foot of one.", again = true)
            else -> Words("The mail service did not take $to" + (s.said?.let { ": $it" } ?: "") + ". Check the address.", again = true)
        }
    }
}
