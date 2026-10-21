package com.restopos.core.display

import com.restopos.core.kitchen.Wire
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.MessageDigest

// What a till and a customer display say to each other over the shop's own
// Wi-Fi. Framed and signed as a till and a kitchen screen are (Wire): the
// till opens a short connection to the display's address, writes one request
// and reads one reply, then closes it.
//
//   till     -> display  <the request, one line of JSON>\n<its signature>\n
//   display  -> till     <the reply, one line of JSON>\n
//
// Its own message, version and port, so that a kitchen screen and a display
// never take each other's requests.

// `display` is the display's name where it was added ("Counter"). `logo` is
// the business's logo (a data URL, as on the receipts), sent only when the
// display said it holds another one; "" means the business has none.
//
// `posters` is the hashes of the pictures the display shows in turn, in
// their order (picked on the till); `poster` one of them that the display
// said it lacks, sent whole, one per exchange. A till before them sends
// neither, and its display shows no pictures.
@Serializable
data class DisplayRequest(
    val v: Int = DisplayWire.VERSION,
    val till: String,
    val tillName: String,
    val display: String,
    val picture: Picture,
    val logo: String? = null,
    val logoHash: String = "",
    val now: Long = 0,
    val posters: List<String> = emptyList(),
    val poster: Poster? = null,
)

// One picture whole: its hash and its JPEG in base64.
@Serializable
data class Poster(val hash: String, val jpeg: String)

// `error` when not ok: "refused" (not signed with this display's code) or
// "version" (the two ends speak different versions; `build` says the
// display's). `logoHash` is the hash of the logo the display holds now.
@Serializable
data class DisplayReply(
    val ok: Boolean,
    val error: String? = null,
    val v: Int = DisplayWire.VERSION,
    val build: Int = 0,
    val logoHash: String = "",
    // the hashes of the pictures it holds, of those it was told of
    val posters: List<String> = emptyList(),
)

object DisplayWire {
    const val VERSION = 1
    // the kitchen screen's is 9310
    const val PORT = 9311
    const val REFUSED = "refused"
    const val OTHER_VERSION = "version"

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun encode(req: DisplayRequest, code: String): String {
        val line = json.encodeToString(DisplayRequest.serializer(), req)
        return line + "\n" + Wire.sign(code, line) + "\n"
    }

    // The request, or null when it was not signed with this code, was changed
    // on the way, or is not a request at all.
    fun decode(first: String, second: String, code: String): DisplayRequest? {
        val want = Wire.sign(code, first).toByteArray(Charsets.UTF_8)
        if (!MessageDigest.isEqual(want, second.trim().toByteArray(Charsets.UTF_8))) return null
        return runCatching { json.decodeFromString(DisplayRequest.serializer(), first) }.getOrNull()
    }

    fun encode(reply: DisplayReply): String = json.encodeToString(DisplayReply.serializer(), reply) + "\n"

    fun decodeReply(line: String): DisplayReply? = runCatching { json.decodeFromString(DisplayReply.serializer(), line) }.getOrNull()

    // A logo as the two ends compare it: the first 16 hex digits of its
    // SHA-256, "" for none.
    fun hash(logo: String?): String {
        if (logo.isNullOrEmpty()) return ""
        val d = MessageDigest.getInstance("SHA-256").digest(logo.toByteArray(Charsets.UTF_8))
        return d.joinToString("") { "%02x".format(it) }.take(16)
    }

    // A picture's hash, as for a logo
    fun hash(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }.take(16)

    // A display's address as it was typed: an IP, or IP:port.
    fun address(text: String?): Pair<String, Int>? = Wire.address(text, PORT)

    // What is wrong with a display, in words for Settings, Printers; null when
    // it answered. `reply` is null when nothing answered at all.
    fun trouble(name: String, address: String?, reply: DisplayReply?): String? = when {
        reply?.ok == true -> null
        address(address) == null -> "$name has no address that can be reached. Type the one the display shows."
        reply == null -> "$name is not answering. Check the display tablet is on, has EasyPay open, and is on the same Wi-Fi as this till."
        reply.error == REFUSED -> "$name refused this till: its pairing code is not the one typed for it. Type the code the display shows."
        reply.error == OTHER_VERSION -> "$name runs another version of EasyPay. Update this till and the display to the same one."
        else -> "$name did not take the sale (${reply.error ?: "no reason given"})."
    }
}
