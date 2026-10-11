package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

// The size a product's picture is kept at, and by how much a large one is read smaller.
class PicturesTest {
    @Test fun `a picture is kept in its own shape, its long side 640 at most`() {
        assertEquals(640 to 480, Pictures.fit(4000, 3000, 640))
        assertEquals(480 to 640, Pictures.fit(3000, 4000, 640))
        assertEquals(640 to 640, Pictures.fit(1280, 1280, 640))
        // a long thin one keeps at least a pixel of its short side
        assertEquals(640 to 1, Pictures.fit(100_000, 10, 640))
    }

    @Test fun `one that is small already is left as it is`() {
        assertEquals(320 to 240, Pictures.fit(320, 240, 640))
        assertEquals(640 to 200, Pictures.fit(640, 200, 640))
        assertEquals(1 to 1, Pictures.fit(0, 0, 640))
    }

    @Test fun `a photograph is read at a fraction, and never below what is kept`() {
        // 4000 wide: an eighth would be 500, under 640, so a quarter (1000)
        assertEquals(4, Pictures.sample(4000, 3000, 640))
        assertEquals(1, Pictures.sample(1000, 800, 640))
        assertEquals(2, Pictures.sample(1280, 960, 640))
        assertEquals(8, Pictures.sample(3000, 6000, 640))
        assertEquals(1, Pictures.sample(640, 480, 640))
    }
}
