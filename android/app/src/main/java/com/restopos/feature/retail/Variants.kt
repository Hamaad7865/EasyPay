package com.restopos.feature.retail

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.data.VariantForm
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn

// A product's options and their values (server 0097): "Size: S, M, L",
// "Colour: White, Navy". Saving makes a variant for every combination the
// product does not have yet, at the product's price. A value that is added
// later makes only its own. Nothing here removes a variant: that is on the
// variant's own sheet.
@Composable
internal fun OptionsSheet(item: ItemEntity, variants: List<ItemVariantEntity>, busy: Boolean, onClose: () -> Unit, onMake: (List<VariantForm.Option>) -> Unit) {
    val names = remember(item.id, item.option_names) { VariantForm.held(item.option_names) }
    val held = remember(variants) { variants.map { VariantForm.held(it.option_values) } }
    // what the product has: each option with the values its variants carry, in the order they were made
    val start = remember(item.id, variants) {
        (0 until 3).map { i ->
            val seen = LinkedHashSet<String>()
            held.forEach { v -> v.getOrNull(i)?.let { seen += it } }
            VariantForm.Option(names.getOrNull(i) ?: "", seen.joinToString(", "))
        }
    }
    var rows by remember(item.id, variants) { mutableStateOf(start) }

    Sheet(onDismiss = { if (!busy) onClose() }, width = 640.dp, pad = 22.dp, gap = 10.dp, top = true) {
        SheetHead("Variants of ${item.name}", if (variants.isEmpty()) "Sizes, colours: what it comes in." else "${variants.size} so far. Add a value to make more.") { if (!busy) onClose() }
        rows.forEachIndexed { i, r ->
            // a product that has variants keeps its number of options
            if (variants.isEmpty() || i < names.size) Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Bottom) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (i == 0) Caps("Option", V.Text2)
                    Field(r.name, { v -> rows = rows.mapIndexed { n, o -> if (n == i) o.copy(name = v.take(30)) else o } }, listOf("Size", "Colour", "Material")[i], Modifier.fillMaxWidth(), height = 50.dp, size = 16.sp)
                }
                Column(Modifier.weight(2.2f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (i == 0) Caps("Its values, with commas between them", V.Text2)
                    Field(r.values, { v -> rows = rows.mapIndexed { n, o -> if (n == i) o.copy(values = v.take(400)) else o } }, listOf("S, M, L", "White, Navy", "Cotton, Linen")[i], Modifier.fillMaxWidth(), height = 50.dp, size = 16.sp)
                }
            }
        }
        T(
            if (variants.isEmpty()) "Every combination becomes a variant, at the product's price. A product that still holds stock of its own cannot be given variants: bring its stock to zero first."
            else "A new value makes its variants only; the ones there stay as they are. A variant is removed from its own Codes sheet.",
            13.sp, 500, V.Text2, lines = 3,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy) { onClose() }
            VBtn(if (busy) "Saving…" else "Make the variants", bg = V.Blue, fg = Color.White, height = 50.dp, weight = 800, enabled = !busy) { onMake(rows) }
        }
    }
}

private fun rupees(cents: Long): String = if (cents % 100 == 0L) (cents / 100).toString() else "%d.%02d".format(cents / 100, cents % 100)

// One variant's own codes: its barcode, its SKU, and what it costs (for
// whoever may see cost). Its price is behind its Price key, where a change of
// price is written down. Removing it is here; one that holds stock stays.
@Composable
internal fun VariantCodesSheet(
    item: ItemEntity, variant: ItemVariantEntity, mayCost: Boolean, busy: Boolean, onClose: () -> Unit,
    onSave: (barcode: String, sku: String, cost: String) -> Unit, onRemove: () -> Unit,
) {
    var barcode by remember(variant.id) { mutableStateOf(variant.barcode ?: "") }
    var sku by remember(variant.id) { mutableStateOf(variant.sku ?: "") }
    var cost by remember(variant.id) { mutableStateOf(variant.cost?.let { rupees(it) } ?: "") }
    var removing by remember(variant.id) { mutableStateOf(false) }

    Sheet(onDismiss = { if (!busy) onClose() }, width = 600.dp, pad = 22.dp, gap = 10.dp, top = true) {
        if (removing) {
            SheetHead("Remove ${item.name}, ${variant.name}?", "Receipts that sold it keep its name. It cannot be removed while it holds stock.") { onClose() }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep it", Modifier.weight(1f), height = 56.dp, enabled = !busy) { removing = false }
                VBtn("Remove it", Modifier.weight(1f), V.Red, Color.White, 56.dp, weight = 800, enabled = !busy) { onRemove() }
            }
            return@Sheet
        }
        SheetHead("${item.name}, ${variant.name}") { if (!busy) onClose() }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1.4f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Caps("Barcode", V.Text2)
                Field(barcode, { barcode = it.take(64) }, "Scan it here, or leave empty", Modifier.fillMaxWidth(), height = 50.dp, size = 16.sp)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Caps("SKU", V.Text2)
                Field(sku, { sku = it.take(60) }, "Your own code", Modifier.fillMaxWidth(), height = 50.dp, size = 16.sp)
            }
            if (mayCost) Column(Modifier.weight(0.9f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Caps("Cost", V.Text2)
                Field(cost, { v -> cost = v.filter { it.isDigit() || it == '.' }.take(10) }, "0.00", Modifier.fillMaxWidth(), height = 50.dp, number = true, size = 16.sp, leading = { T("Rs", 15.sp, 700, V.Text2) })
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            VBtn("Remove", height = 50.dp, fg = V.RedText, enabled = !busy) { removing = true }
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy) { onClose() }
            VBtn(if (busy) "Saving…" else "Save", bg = V.Blue, fg = Color.White, height = 50.dp, weight = 800, enabled = !busy) { onSave(barcode, sku, cost) }
        }
    }
}
