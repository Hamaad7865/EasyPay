package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The owner: "if an order is due 21:00, we need the till to make a sound 10
// mins before", "not all customer wants 10 mins"; only orders for later ring.
class DueReminderTest {
    private val t0 = 1_790_000_000_000L // 20:00, as the cases say it
    private fun at(min: Int) = t0 + min * 60_000L
    private fun order(due: Int?, delivery: Boolean = false, stage: String = "new", id: String = "o1", name: String? = "Ravi", noShow: Boolean = false, taken: Long? = t0) =
        DueReminder.Order(id, "A-05", name, delivery, due?.let { at(it) }, stage, noShow, taken)

    @Test fun `an order for as soon as possible never rings, nor one moved a little later`() {
        assertNull(DueReminder.ringAt(order(15), 15, 10))
        assertNull(DueReminder.ringAt(order(20), 15, 10))
        assertNull(DueReminder.ringAt(order(25), 15, 10))
    }

    @Test fun `an order for later rings the reminder before it is due`() {
        assertEquals(at(50), DueReminder.ringAt(order(60), 15, 10))
        assertEquals(at(16), DueReminder.ringAt(order(26), 15, 10))
    }

    @Test fun `a delivery's usual time is twice the preparation time`() {
        assertNull(DueReminder.ringAt(order(40, delivery = true), 15, 10))
        assertEquals(at(50), DueReminder.ringAt(order(60, delivery = true), 15, 10))
    }

    @Test fun `off, no due time, or not known when it was taken, it never rings`() {
        assertNull(DueReminder.ringAt(order(60), 15, 0))
        assertNull(DueReminder.ringAt(order(null), 15, 10))
        assertNull(DueReminder.ringAt(order(60, taken = null), 15, 10))
    }

    @Test fun `it rings from its moment until it is due, once for each due time`() {
        val o = order(60)
        assertTrue(DueReminder.toRing(listOf(o), at(49), 15, 10, emptySet()).isEmpty())
        assertEquals(listOf("o1"), DueReminder.toRing(listOf(o), at(50), 15, 10, emptySet()).map { it.id })
        // a till started after the moment rings at once, until the order is due
        assertEquals(listOf("o1"), DueReminder.toRing(listOf(o), at(57), 15, 10, emptySet()).map { it.id })
        assertTrue(DueReminder.toRing(listOf(o), at(60), 15, 10, emptySet()).isEmpty())
        // rung already for this due time
        assertTrue(DueReminder.toRing(listOf(o), at(52), 15, 10, setOf(DueReminder.key(o))).isEmpty())
        // moved later, it rings again before the new time
        val moved = order(90)
        assertEquals(listOf("o1"), DueReminder.toRing(listOf(moved), at(80), 15, 10, setOf(DueReminder.key(o))).map { it.id })
    }

    @Test fun `only an order still waiting on the kitchen rings`() {
        val orders = listOf(
            order(60, id = "a"), order(60, stage = "kitchen", id = "b"), order(60, stage = "ready", id = "c"),
            order(60, stage = "done", id = "d"), order(60, id = "e", noShow = true),
        )
        assertEquals(listOf("a", "b"), DueReminder.toRing(orders, at(50), 15, 10, emptySet()).map { it.id })
    }

    @Test fun `what the banner says`() {
        assertEquals("A-05, Ravi, is due at 21:00: in 10 minutes", DueReminder.says(order(60), at(50)) { "21:00" })
        assertEquals("A-05 is due at 21:00: in 1 minute", DueReminder.says(order(60, name = null), at(59) + 30_000) { "21:00" })
    }

    @Test fun `what was rung for is kept, and forgotten two days after it was due`() {
        val kept = mapOf("o1@${at(60)}" to at(60), "o2@${at(-3000)}" to at(-3000))
        assertEquals(mapOf("o1@${at(60)}" to at(60)), DueReminder.read(DueReminder.keep(kept, at(70))))
        assertEquals(emptyMap<String, Long>(), DueReminder.read(null))
        assertEquals(emptyMap<String, Long>(), DueReminder.read("junk"))
    }
}
