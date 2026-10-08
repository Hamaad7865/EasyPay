package com.restopos.core.kitchen

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

// "There is something new for the kitchen screens." An order sent while the
// till is in the middle of asking a screen must not wait for the till's next
// turn: the word is kept until it is heard.
class ScreenKickTest {
    @Test
    fun saidWhileNobodyListensItIsStillThere() = runBlocking {
        val kick = ScreenKick()
        kick.now()
        assertNotNull(withTimeoutOrNull(200) { kick.await() })
    }

    @Test
    fun saidSeveralTimesItIsHeardOnce() = runBlocking {
        val kick = ScreenKick()
        repeat(5) { kick.now() }
        assertNotNull(withTimeoutOrNull(200) { kick.await() })
        assertNull(withTimeoutOrNull(100) { kick.await() })
    }

    @Test
    fun notSaidThereIsNothingToHear() = runBlocking {
        assertNull(withTimeoutOrNull(100) { ScreenKick().await() })
    }
}
