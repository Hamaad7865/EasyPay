package com.restopos.core.kitchen

// A kitchen tablet's storage, kept in memory for the tests: what ScreenBook is
// handed in place of the tablet's own database.
class MemoryShelf(private var epoch: String = "epoch-1") : ScreenShelf {
    private val held = LinkedHashMap<String, ScreenTicket>()
    private val marks = ArrayList<Triple<Long, String, WireMark>>()
    private var seq = 0L

    override suspend fun epoch(): String = epoch
    override suspend fun ticket(id: String): ScreenTicket? = held[id]
    override suspend fun tickets(): List<ScreenTicket> = held.values.toList()
    override suspend fun save(ticket: ScreenTicket) { held[ticket.id] = ticket }
    override suspend fun log(till: String, mark: WireMark): Long { marks.add(Triple(++seq, till, mark)); return seq }
    override suspend fun logged(till: String, after: Long): List<Pair<Long, WireMark>> =
        marks.filter { it.second == till && it.first > after }.map { it.first to it.third }
    override suspend fun lastSeq(till: String): Long = marks.lastOrNull { it.second == till }?.first ?: 0
    override suspend fun prune(before: Long) { held.values.removeAll { it.receivedAt < before } }

    // the tablet set up afresh: nothing it was sent is left
    fun wipe(newEpoch: String) { held.clear(); marks.clear(); seq = 0; epoch = newEpoch }
}
