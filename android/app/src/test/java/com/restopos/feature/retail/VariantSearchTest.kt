package com.restopos.feature.retail

import com.restopos.core.database.ItemVariantEntity
import org.junit.Assert.assertEquals
import org.junit.Test

class VariantSearchTest {
    private fun v(name: String, sku: String? = null, barcode: String? = null) = ItemVariantEntity(name, "t", "i", name, 97500, sku, barcode)
    private val shirts = listOf(
        v("Black / 15 / Plain", "ch15tb/c", "2000000000015"),
        v("Black / 15 / Design", "ch15tbd/c"),
        v("Navy Blue / 4 / stripe", "ch4nb/s"),
        v("Pale Blue / 15 / Plain", "ch15pb/c"),
    )
    private fun names(q: String) = variantsMatching(shirts, q).map { it.name }

    @Test fun `every word typed is in the variant, in any order and any case`() {
        assertEquals(listOf("Black / 15 / Plain", "Black / 15 / Design"), names("black 15"))
        assertEquals(listOf("Black / 15 / Plain", "Pale Blue / 15 / Plain"), names("PLAIN 15"))
        assertEquals(listOf("Navy Blue / 4 / stripe"), names("blue stripe"))
    }

    @Test fun `a SKU or a barcode finds its variant`() {
        assertEquals(listOf("Black / 15 / Design"), names("ch15tbd"))
        assertEquals(listOf("Black / 15 / Plain"), names("2000000000015"))
    }

    @Test fun `nothing typed shows them all, something no variant has shows none`() {
        assertEquals(shirts.map { it.name }, names("   "))
        assertEquals(emptyList<String>(), names("red"))
    }
}
