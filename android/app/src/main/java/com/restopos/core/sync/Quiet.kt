package com.restopos.core.sync

// When a till asks the server for news without being asked to.
//
// A till syncs each sale as it is made, and asks for what changed in the back
// office every 15 minutes. The database behind the server is paid for by the
// hour it is awake, and it goes to sleep five minutes after the last thing
// said to it. A tablet left on through the night, asking every 15 minutes,
// kept it awake a third of the night for nothing: no one was there to sell
// anything, and nothing it fetched was looked at.
//
// So the 15-minute sync goes to the server only while someone is at the till
// (a touch, a key or a scan in the last half hour), or while something is
// still waiting to go up: a sale is never left on the tablet for tomorrow's
// first touch. Left alone, the till stops asking. The first touch after that
// syncs at once, so prices changed overnight are there when the shop opens.
//
// A sync that was asked for (the till opening, a sale just sent, the key by
// the clock, a sign-in) always goes, as before.
//
// Times are the tablet's clock, in milliseconds, because what is written down
// has to mean something after the app has been closed and opened again.
internal object Quiet {
    /** Left untouched this long, a till stops asking. Two of its 15-minute turns. */
    const val AFTER_MS = 30 * 60_000L

    /** A touch is written to the tablet's storage this often at most. */
    const val NOTE_EVERY_MS = 60_000L

    /** Is someone at the till: was it used in the last half hour. */
    private fun inUse(now: Long, lastUse: Long?): Boolean = lastUse != null && now - lastUse in 0 until AFTER_MS

    /**
     * Does this sync go to the server.
     * [asked]: someone or something asked for it. [waiting]: the outbox holds
     * what has not gone up yet. [lastUse]: when the till was last used, or
     * null when nothing says it ever was.
     */
    fun syncs(asked: Boolean, waiting: Boolean, now: Long, lastUse: Long?): Boolean = asked || waiting || inUse(now, lastUse)

    /**
     * Is this touch the first after the till was left alone: it should catch
     * up at once. Not the first touch since the app opened ([lastUse] null):
     * opening it has synced already.
     */
    fun back(now: Long, lastUse: Long?): Boolean = lastUse != null && !inUse(now, lastUse)

    /** Is this touch worth writing down: none was, or the last one is a minute old (or the clock went back). */
    fun notes(now: Long, noted: Long?): Boolean = noted == null || now - noted >= NOTE_EVERY_MS || now < noted
}
