package com.restopos.core.kitchen

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable

// A line on a kitchen screen: as it was sent, and what has happened to it
// since. A voided line stays, struck through: the cooks must see it go.
@Serializable
data class ScreenLine(
    val id: String, val qty: Int, val name: String, val detail: String = "",
    val done: Boolean = false, val voided: Boolean = false,
)

// One till's ticket as a kitchen screen holds it: this screen's part of one
// send. `receivedAt` is this tablet's own clock, and is what its age is
// counted from: two tablets' clocks drift apart, and a ticket must not arrive
// already late. `bumpedAt` is set once the cooks have it at the pass.
data class ScreenTicket(
    val id: String, val till: String, val tillName: String, val tillCode: String, val screen: String,
    val no: Int, val label: String, val kind: String, val covers: Int?, val waiter: String?, val remark: String?,
    val sentAt: Long, val receivedAt: Long, val bumpedAt: Long? = null, val lines: List<ScreenLine>,
)

// Where a kitchen tablet keeps what it was sent and what the cooks did: its
// own small database (KitchenDatabase), or a map in the tests. It only keeps;
// every rule is ScreenBook's, so the two cannot differ.
interface ScreenShelf {
    // made when the tablet was set up as a kitchen screen
    suspend fun epoch(): String
    suspend fun ticket(id: String): ScreenTicket?
    suspend fun tickets(): List<ScreenTicket>
    suspend fun save(ticket: ScreenTicket)
    // what a cook did, for the till it concerns; numbered as it is written
    suspend fun log(till: String, mark: WireMark): Long
    suspend fun logged(till: String, after: Long): List<Pair<Long, WireMark>>
    suspend fun lastSeq(till: String): Long
    suspend fun prune(before: Long)
}

// A till this screen heard from, and when (this tablet's clock).
data class Heard(val till: String, val name: String, val at: Long) {
    // For the screen's header: "Terminal 01 · just now", "Terminal 01 · 40 s
    // ago", and once a till has been silent for a minute, that it has: a
    // kitchen that is not being sent orders should be able to see why.
    fun text(now: Long): String {
        val s = ((now - at) / 1000).coerceAtLeast(0)
        return when {
            s < 10 -> "$name · just now"
            s < 60 -> "$name · $s s ago"
            s < 3600 -> "No till for ${s / 60} min"
            else -> "No till for ${s / 3600} h"
        }
    }
}

// The kitchen tablet's side of the link: what it does with a till's request,
// what it answers, and what a cook's tap does. One thing at a time: a till's
// request and a cook's tap never cross.
class ScreenBook(
    private val shelf: ScreenShelf,
    private val code: suspend () -> String,
    private val build: Int,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val turn = Mutex()
    private val _heard = MutableStateFlow<Heard?>(null)
    // the till that asked last, for the screen's header
    val heard: StateFlow<Heard?> = _heard

    // The reply to a request, always one line. A request that is not signed
    // with this screen's code is told nothing but "refused".
    suspend fun answer(first: String, second: String): String = turn.withLock {
        val req = Wire.decode(first, second, code()) ?: return@withLock Wire.encode(WireReply(ok = false, error = Wire.REFUSED))
        if (req.v != Wire.VERSION) return@withLock Wire.encode(WireReply(ok = false, error = Wire.OTHER_VERSION, build = build))
        val now = clock()
        // A ticket the screen holds is replaced, never added again, and keeps
        // when it arrived, whether it was bumped and what the cooks ticked.
        for (t in req.put) {
            val was = shelf.ticket(t.id)
            if (was != null && was.till != req.till) continue
            val kept = was?.lines?.associateBy { it.id }.orEmpty()
            shelf.save(
                ScreenTicket(
                    t.id, req.till, req.tillName, req.tillCode, req.screen, t.no, t.label, t.kind, t.covers, t.waiter, t.remark, t.sentAt,
                    receivedAt = was?.receivedAt ?: now, bumpedAt = was?.bumpedAt,
                    lines = t.lines.map { l -> ScreenLine(l.id, l.qty, l.name, l.detail, kept[l.id]?.done ?: false, kept[l.id]?.voided ?: false) },
                ),
            )
        }
        // What the till says a thing is now, for its own tickets only. None
        // of it is the cooks' doing, so none of it is written to their list.
        for (m in req.marks) {
            if (m.line != null) {
                val t = shelf.tickets().firstOrNull { it.till == req.till && it.lines.any { l -> l.id == m.line } } ?: continue
                shelf.save(t.copy(lines = t.lines.map { if (it.id == m.line) it.copy(done = m.done ?: it.done, voided = m.voided ?: it.voided) else it }))
            } else if (m.ticket != null && m.bumped != null) {
                val t = shelf.ticket(m.ticket)?.takeIf { it.till == req.till } ?: continue
                shelf.save(t.copy(bumpedAt = if (m.bumped) t.bumpedAt ?: now else null))
            }
        }
        _heard.value = Heard(req.till, req.tillName, now)
        Wire.encode(
            WireReply(
                ok = true, build = build, epoch = shelf.epoch(), seq = shelf.lastSeq(req.till),
                marks = shelf.logged(req.till, req.after).map { it.second },
                have = shelf.tickets().filter { it.till == req.till }.map { it.id },
            ),
        )
    }

    // What is on the screen: the tickets not yet bumped, the one that has
    // waited longest first.
    suspend fun open(): List<ScreenTicket> = turn.withLock { shown(shelf.tickets()) }

    // A cook taps a line: done, or not done after all. A voided line is not
    // anyone's to tick.
    suspend fun tap(lineId: String) = turn.withLock {
        val t = shelf.tickets().firstOrNull { it.bumpedAt == null && it.lines.any { l -> l.id == lineId } } ?: return@withLock
        val l = t.lines.first { it.id == lineId }
        if (l.voided) return@withLock
        shelf.save(t.copy(lines = t.lines.map { if (it.id == lineId) it.copy(done = !l.done) else it }))
        shelf.log(t.till, WireMark(line = lineId, done = !l.done))
    }

    // Bump: this screen's part is at the pass and leaves the screen. It is
    // still held, so the till does not send it again. Says what was bumped.
    suspend fun bump(ticketId: String): String? = turn.withLock {
        val t = shelf.ticket(ticketId)?.takeIf { it.bumpedAt == null } ?: return@withLock null
        shelf.save(t.copy(bumpedAt = clock()))
        shelf.log(t.till, WireMark(ticket = t.id, bumped = true))
        t.label
    }

    suspend fun canRecall(): Boolean = turn.withLock { lastBumped() != null }

    // Recall: the part bumped last comes back, as it was. Says what came back.
    suspend fun recallLast(): String? = turn.withLock {
        val t = lastBumped() ?: return@withLock null
        shelf.save(t.copy(bumpedAt = null))
        shelf.log(t.till, WireMark(ticket = t.id, bumped = false))
        t.label
    }

    // Tickets from days gone by are of no use to anyone.
    suspend fun prune() = turn.withLock { shelf.prune(clock() - KEEP_MS) }

    private suspend fun lastBumped(): ScreenTicket? {
        val since = clock() - RECALL_MS
        return shelf.tickets().filter { it.bumpedAt != null && it.bumpedAt > since }.maxByOrNull { it.bumpedAt ?: 0 }
    }

    companion object {
        const val KEEP_MS = 3 * 24 * 3_600_000L
        const val RECALL_MS = 12 * 3_600_000L

        // the order of the screen, for whoever shows it from the shelf itself
        fun shown(all: List<ScreenTicket>): List<ScreenTicket> =
            all.filter { it.bumpedAt == null }.sortedWith(compareBy<ScreenTicket> { it.receivedAt }.thenBy { it.no })
    }
}
