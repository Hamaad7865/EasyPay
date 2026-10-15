package com.restopos.core.common

import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// An id made on the tablet carries the moment it was made (UUID version 7):
// the reminder before an order is due reads when the order was taken from it.
class Uuid7Test {
    @Test fun anIdKnowsWhenItWasMade() {
        val before = System.currentTimeMillis()
        val id = Uuid7.next()
        val after = System.currentTimeMillis()
        val ms = Uuid7.millis(id)!!
        assertTrue(ms in before..after)
    }

    @Test fun anIdThatIsNotOneOfOursKnowsNothing() {
        // version 4, as the server's gen_random_uuid makes
        assertNull(Uuid7.millis("3f2b8c1e-9d4a-4b6e-8f00-123456789abc"))
        assertNull(Uuid7.millis("not an id"))
    }
}
