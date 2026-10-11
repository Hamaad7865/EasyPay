package com.restopos.core.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// How large the till is drawn. The sizes are the room the screens have in
// Android's dp: the tablet's own, less the status bar and the bar of keys.
class ScreenFitTest {
    private fun layout(w: Float, h: Float): Pair<Float, Float> = ScreenFit.scale(w, h).let { w / it to h / it }

    // The owner's 10-inch: 1280 x 800, a status bar and three keys along the
    // bottom. It was drawn at 1, and "the components are too small".
    @Test
    fun aTenInchIsDrawnAFifthLarger() {
        assertEquals(1.2f, ScreenFit.scale(1280f, 728f), 0.001f)
        // the same tablet on an Android that hides the keys: no larger, more room
        assertEquals(1.2f, ScreenFit.scale(1280f, 776f), 0.001f)
        // and whichever way round it is held when the till opens
        assertEquals(1.2f, ScreenFit.scale(728f, 1280f), 0.001f)
    }

    // A 15-inch showed the full layout enlarged: it still does, no larger.
    @Test
    fun aLargeTillIsDrawnAsBefore() {
        assertEquals(1000f / 720f, ScreenFit.scale(1920f, 1000f), 0.001f)
        assertEquals(1.5f, ScreenFit.scale(1920f, 1200f), 0.001f)
        val (w, h) = layout(1920f, 1000f)
        assertTrue(w >= ScreenFit.WIDTH - 0.5f && h >= ScreenFit.HEIGHT - 0.5f)
    }

    // Between the two, the till is at LEAST and the room grows with the tablet.
    @Test
    fun aTabletInBetweenIsNeverDrawnSmallerThanTheLeast() {
        assertEquals(1.2f, ScreenFit.scale(1440f, 850f), 0.001f)
        assertEquals(1.2f, ScreenFit.scale(1536f, 864f), 0.001f)
        // from here on the full layout fits larger than that
        assertEquals(1.25f, ScreenFit.scale(1600f, 1000f), 0.001f)
    }

    // A tablet too small for the least: the smallest layout, fitted to it.
    @Test
    fun aSmallTabletGetsTheSmallestLayout() {
        // 16:9 with a tall bar of keys, the lowest there is
        assertEquals(1.2f * 640f / 720f, ScreenFit.scale(1280f, 640f), 0.001f)
        // an 8-inch
        assertEquals(0.96f, ScreenFit.scale(1024f, 600f), 0.001f)
        // a phone is not a till, but the app still opens on one
        assertEquals(0.6f, ScreenFit.scale(640f, 336f), 0.001f)
    }

    // What every screen is checked against: whatever the tablet, the room is
    // never less than the smallest layout, 1280 / 1.2 x 720 / 1.2.
    @Test
    fun noTabletLeavesTheScreensLessThanTheSmallestLayout() {
        val leastW = ScreenFit.WIDTH / ScreenFit.LEAST
        val leastH = ScreenFit.HEIGHT / ScreenFit.LEAST
        for (w in 800..2600 step 20) for (h in 480..1700 step 20) {
            if (h > w) continue
            val scale = ScreenFit.scale(w.toFloat(), h.toFloat())
            if (scale <= 0.6f || scale >= 2f) continue // the ends: a phone, a wall screen
            val (lw, lh) = layout(w.toFloat(), h.toFloat())
            assertTrue("$w x $h at $scale: $lw x $lh", lw >= leastW - 0.5f && lh >= leastH - 0.5f)
            // and never drawn smaller than it was before
            val before = minOf(w / ScreenFit.WIDTH, h / ScreenFit.HEIGHT)
            assertTrue("$w x $h", scale >= before - 0.001f)
        }
    }
}
