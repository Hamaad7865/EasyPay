package com.restopos.core.ui

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The selling screens' widths: the categories down the side and the sale
// must leave the products their cards, on the 10-inch and on a large till.
class SellFitTest {
    // what is left for the cards on a screen this wide: its margins (12 each
    // side), the categories, the sale, and the 12 between each
    private fun cards(width: Float): Float {
        val narrow = SellFit.narrow(width.dp)
        return width - 24f - SellFit.rail(narrow).value - SellFit.sale(narrow).value - 24f
    }

    // GridCells.Adaptive(150.dp) with 10 between: n cards need 160n - 10
    private fun fit(n: Int) = 160f * n - 10f

    @Test
    fun theTenInchIsNarrowAndALargeTillIsNot() {
        assertTrue(SellFit.narrow(1067.dp))
        assertFalse(SellFit.narrow(1280.dp))
        assertFalse(SellFit.narrow(1440.dp))
    }

    @Test
    fun aTenInchHasThreeCardsToARowAndALargeTillFour() {
        assertTrue(cards(1067f) >= fit(3))
        assertTrue(cards(1280f) >= fit(4))
    }
}
