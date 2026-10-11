package com.restopos.feature.menu

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Uuid7
import com.restopos.core.data.Approvals
import com.restopos.core.data.ItemForm
import com.restopos.core.data.ItemMore
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StockForm
import com.restopos.core.data.TaxForm
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.Toggle
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.press
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

// The item on the sheet: one being changed, or (item = null) a new one that
// starts in the category the list was showing. newId is what a new one will
// be saved under: made when the sheet opens, so a second try after a lost
// answer sends the same one and the server makes nothing twice.
class ItemEdit(val item: ItemEntity?, val category: String?, val fixedPrice: Boolean = false, val newId: String = Uuid7.next())

// An item made, changed or removed from the till: a restaurant's Menu screen
// and a shop's Products & stock both hold one of these and draw ItemSheet
// from it. The till asks the server and waits for its answer (see
// ServiceRepository.saveItem), so the keys are held while it does. Someone
// who may not edit the menu asks someone who may; the sheet closes while
// they do, and what was typed goes with the question.
class ItemEditor(private val service: ServiceRepository, private val approvals: Approvals, private val scope: CoroutineScope, private val shop: Boolean) {
    val editing = MutableStateFlow<ItemEdit?>(null)
    val busy = MutableStateFlow(false)
    // What the sheet's second page starts from, read when a sheet opens, and which sheet it was read for.
    val more = MutableStateFlow<Pair<ItemEdit, ItemMore>?>(null)
    private val thing = if (shop) "product" else "item"

    fun new(category: String?) = show(ItemEdit(null, category))
    // fixedPrice: a product whose variants or weight carry its price; it cannot be one whose price is typed
    fun open(item: ItemEntity, fixedPrice: Boolean = false) = show(ItemEdit(item, item.category_id, fixedPrice))
    fun close() { if (!busy.value) editing.value = null }

    private fun show(edit: ItemEdit) {
        editing.value = edit
        scope.launch { more.value = edit to service.itemMore(edit.item?.id) }
    }

    // count: whether its stock is counted, as the sheet's switch stands
    // typed: the sheet's second page, or null when it had not been read yet: the server then leaves all of it as it is
    // from: that page as it opened, for an item being changed: only what was changed since is sent
    fun save(
        name: String, price: String, open: Boolean, category: String?, barcode: String, available: Boolean, count: Boolean,
        typed: ItemForm.Typed? = null, from: ItemForm.Typed? = null, by: StaffMember? = null, done: () -> Unit = {},
    ) {
        val edit = editing.value ?: return
        val read = ItemForm.read(name, price, open, barcode).getOrElse { Toaster.say(it.message ?: "That is not an $thing yet"); return }
        val second = typed?.let { t -> ItemForm.readMore(t, from.takeIf { edit.item != null }).getOrElse { Toaster.say(it.message ?: "That is not an $thing yet"); return } }
        if (busy.value) return
        scope.launch {
            busy.value = true
            val out = service.saveItem(edit.item?.id ?: edit.newId, read, category, available, shop, by, count && !read.open, second)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                editing.value = null
                approvals.ask(need.permission, need.what) { approver -> editing.value = edit; save(name, price, open, category, barcode, available, count, typed, from, approver, done) }
            } else out.fold(
                {
                    editing.value = null
                    Toaster.say(if (edit.item == null) "${read.name} is added." + com.restopos.core.data.Journey.others else "${read.name} is saved." + com.restopos.core.data.Journey.others)
                    done()
                },
                { Toaster.say(it.message ?: "That did not work") },
            )
        }
    }

    fun remove(by: StaffMember? = null, done: () -> Unit = {}) {
        val edit = editing.value
        val item = edit?.item ?: return
        if (busy.value) return
        scope.launch {
            busy.value = true
            val out = service.removeItem(item.id, shop, by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                editing.value = null
                approvals.ask(need.permission, need.what) { approver -> editing.value = edit; remove(approver, done) }
            } else out.fold(
                { editing.value = null; Toaster.say("${item.name} is removed. Receipts that sold it keep its name."); done() },
                { Toaster.say(it.message ?: "That did not work") },
            )
        }
    }
}

private fun rupees(cents: Long): String = if (cents % 100 == 0L) (cents / 100).toString() else "%d.%02d".format(cents / 100, cents % 100)

// What the till can make or change of an item, on two pages. The first: its
// name, its price or that its price is typed at the sale, its category, its
// barcode, whether it is on sale and whether its stock is counted; and it can
// remove it. The second (server 0094): its tax, and for a shop its cost (for
// whoever may see cost), SKU, brand, supplier and the supplier's code, and
// when and how much to reorder. Variants and add-ons are still the back
// office's.
// stock: given for an item whose stock can be changed from here (the
// restaurant's menu); it closes this sheet and opens the stock's.
@Composable
internal fun ItemSheet(editor: ItemEditor, edit: ItemEdit, cats: List<CategoryEntity>, shop: Boolean, stock: ((StockForm.Way) -> Unit)? = null, done: () -> Unit = {}) {
    val was = edit.item
    val thing = if (shop) "product" else "item"
    val busy by editor.busy.collectAsState()
    val pictures = com.restopos.core.ui.LocalPictures.current as? com.restopos.core.data.Pictures
    var name by remember(edit) { mutableStateOf(was?.name ?: "") }
    var price by remember(edit) { mutableStateOf(if (was == null || was.open_price) "" else rupees(was.price)) }
    var open by remember(edit) { mutableStateOf(was?.open_price ?: false) }
    var cat by remember(edit) { mutableStateOf(was?.category_id ?: edit.category) }
    var barcode by remember(edit) { mutableStateOf(was?.barcode ?: "") }
    var onSale by remember(edit) { mutableStateOf(was?.is_available ?: true) }
    // a shop's new product is counted unless told otherwise, a restaurant's new item is not (migration 0084)
    var count by remember(edit) { mutableStateOf(was?.track_stock ?: shop) }
    // a category that counts its stock counts every item in it, whatever the item says
    val byCategory = cats.firstOrNull { it.id == cat }?.is_stock == true
    var removing by remember(edit) { mutableStateOf(false) }

    // The second page. What it starts from is read when the sheet opens, a
    // moment after it; until then the page waits, and a save sends none of it.
    val loaded by editor.more.collectAsState()
    val more = loaded?.takeIf { it.first === edit }?.second
    var page by remember(edit) { mutableStateOf(0) }
    var taxId by remember(edit, more) { mutableStateOf(more?.taxId) }
    var cost by remember(edit) { mutableStateOf(was?.cost?.let { rupees(it) } ?: "") }
    var sku by remember(edit) { mutableStateOf(was?.sku ?: "") }
    var brand by remember(edit) { mutableStateOf(was?.brand ?: "") }
    // a supplier that was removed since is not one to keep
    var supplier by remember(edit, more) { mutableStateOf(was?.supplier_id?.takeIf { id -> more?.suppliers?.any { it.id == id } == true }) }
    var supplierCode by remember(edit) { mutableStateOf(was?.supplier_code ?: "") }
    var reorder by remember(edit, more) { mutableStateOf(ItemForm.shown(more?.reorder)) }
    var orderQty by remember(edit, more) { mutableStateOf(ItemForm.shown(more?.orderQty)) }
    // the add-on groups a restaurant's item carries
    var groups by remember(edit, more) { mutableStateOf(more?.groupIds ?: emptySet()) }
    // a product with variants keeps its codes and its costs on them
    val costShown = shop && more?.mayCost == true && !more.variants
    val skuShown = more?.variants != true
    fun typed() = ItemForm.Typed(taxId, shop, costShown, cost, skuShown, sku, brand, supplier, supplierCode, reorder, orderQty, groups = if (shop) null else groups)
    // the page as it opened: of an item being changed, only what differs from this is sent
    val start = remember(edit, more) { more?.let { typed() } }

    // top: the keyboard takes the lower half of the screen
    // The sheet is as tall as the screen allows with its keys in view: the row of pages took the room
    // that 12 between rows, fields of 52 and the last line kept for the second page give back.
    Sheet(onDismiss = { editor.close() }, width = 640.dp, gap = 12.dp, top = true) {
        if (removing && was != null) {
            SheetHead("Remove ${was.name}?", "It goes from every till. Receipts that sold it keep its name, and an order that still holds it is taken as it is.") { editor.close() }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep it", Modifier.weight(1f), height = 60.dp, enabled = !busy) { removing = false }
                // its picture goes with it, once it is removed
                VBtn("Remove it", Modifier.weight(1f), V.Red, Color.White, 60.dp, weight = 800, enabled = !busy) { editor.remove(done = { pictures?.remove(was.id); done() }) }
            }
            return@Sheet
        }
        SheetHead(if (was == null) "New $thing" else was.name, com.restopos.core.data.Journey.needs) { editor.close() }

        Row {
            Seg(
                listOf(
                    SegOption("Basics", page == 0) { page = 0 },
                    SegOption(if (!shop) "Tax and add-ons" else if (costShown) "Tax, cost and supplier" else "Tax and supplier", page == 1) { page = 1 },
                    // the picture on its card: the tablet's own, kept at once and apart from Save
                    SegOption("Picture", page == 2) { page = 2 },
                ),
                well = V.Key, height = 36.dp, radius = 12.dp, size = 14.sp,
            )
        }

        if (page == 0) {
            Caps("Name", V.Text2)
            Field(name, { name = it.take(80) }, if (shop) "What the product is called" else "What the item is called", Modifier.fillMaxWidth(), height = 52.dp, size = 17.sp)

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Caps("Price", V.Text2)
                    Field(
                        if (open) "" else price, { v -> if (!open) price = v.filter { it.isDigit() || it == '.' }.take(10) },
                        if (open) "Typed at the sale" else "0.00", Modifier.fillMaxWidth(), height = 52.dp, number = true, size = 17.sp,
                        leading = { T("Rs", 16.sp, 700, V.Text2) },
                    )
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Caps("Barcode", V.Text2)
                    // a shop's tablet that works on its own gives a product saved with none one of EasyPay's (LocalAnswers)
                    Field(
                        barcode, { barcode = it.take(64) },
                        if (shop && com.restopos.core.data.Journey.alone) "Scan it, or EasyPay makes one" else "Scan it here, or leave empty",
                        Modifier.fillMaxWidth(), height = 52.dp, size = 17.sp,
                    )
                }
            }

            // The two switches side by side, and the categories on one row that
            // slides: the sheet has to fit the screen with its keys in view,
            // however many categories a menu has.
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                // a service, or anything charged differently each time: tapping it on the till opens the keypad for its price
                if (!edit.fixedPrice) Switch("Price typed at the sale", open, Modifier.weight(1f)) { open = !open }
                Switch("On sale", onSale, Modifier.weight(1f)) { onSale = !onSale }
            }
            if (open) T("Tapping it on the till opens the keypad: for a service, or anything charged differently each time.", 13.sp, 500, V.Text2, lines = 2)

            // One whose price is typed at the sale is a service: it has no stock to count.
            if (!open) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Switch("Count its stock", count || byCategory, Modifier.weight(1f)) {
                        if (byCategory) Toaster.say("Its category counts stock, so this ${thing}'s is counted too." + if (com.restopos.core.data.Journey.alone) "" else " That is set in the back office.") else count = !count
                    }
                    // stock can be changed once the server counts it: after a save, not before
                    if (stock != null && was != null && !was.open_price && (was.track_stock || byCategory)) {
                        VBtn("Add stock", height = 52.dp, radius = 14.dp, enabled = !busy) { stock(StockForm.Way.In) }
                        VBtn("Remove stock", height = 52.dp, radius = 14.dp, enabled = !busy) { stock(StockForm.Way.Out) }
                    }
                }
                if (count && !byCategory && was?.track_stock != true) T(
                    if (was == null) "It will say Out on every till until stock is added: save it, then open it again to add some."
                    else "It will say Out on every till until stock is added. Save, then open it again to add some.",
                    13.sp, 500, V.AmberText, lines = 2,
                )
            }

            Caps("Category", V.Text2)
            Picks {
                (listOf<CategoryEntity?>(null) + cats).forEach { c -> Pick(c?.name ?: "No category", c?.id == cat) { cat = c?.id } }
            }
        } else if (page == 2) {
            PicturePage(was?.id ?: edit.newId, thing)
        } else if (more == null) {
            T("One moment…", 14.sp, 500, V.Text2)
        } else {
            Caps("Tax", V.Text2)
            if (more.taxes.isEmpty()) T("No tax is set up yet. Add one in Settings, under Taxes.", 13.sp, 500, V.Text2, lines = 2)
            else Picks {
                more.taxes.forEach { t -> Pick("${t.name} · ${TaxForm.rate(t.rate_bp)}%", t.id == taxId) { taxId = t.id } }
            }

            if (!shop) {
                Caps("Add-ons it carries", V.Text2)
                if (more.groups.isEmpty()) T("No add-on group yet. Add them on the Menu, under Add-ons.", 13.sp, 500, V.Text2, lines = 2)
                else {
                    Picks { more.groups.forEach { g -> Pick(g.name, g.id in groups) { groups = if (g.id in groups) groups - g.id else groups + g.id } } }
                    T("Ordering it asks for a choice from each group ticked.", 13.sp, 500, V.Text3)
                }
            }
            if (shop) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
                    if (costShown) Labelled("Cost", Modifier.weight(1f)) {
                        Field(
                            cost, { v -> cost = v.filter { it.isDigit() || it == '.' }.take(10) }, "0.00", Modifier.fillMaxWidth(), height = 56.dp, number = true, size = 17.sp,
                            leading = { T("Rs", 16.sp, 700, V.Text2) },
                        )
                    }
                    if (skuShown) Labelled("SKU", Modifier.weight(1f)) {
                        Field(sku, { sku = it.take(60) }, "Your own code", Modifier.fillMaxWidth(), height = 56.dp, size = 17.sp)
                    }
                    Labelled("Brand", Modifier.weight(1f)) {
                        Field(brand, { brand = it.take(60) }, "If it has one", Modifier.fillMaxWidth(), height = 56.dp, size = 17.sp)
                    }
                }
                if (more.variants) T("A product with variants keeps its SKU and its cost on each variant.", 13.sp, 500, V.Text2, lines = 2)

                Caps("Supplier", V.Text2)
                if (more.suppliers.isEmpty()) T("No supplier is set up yet. Add them on Stock, under Suppliers.", 13.sp, 500, V.Text2, lines = 2)
                else Picks {
                    Pick("None", supplier == null) { supplier = null }
                    more.suppliers.forEach { s -> Pick(s.name, s.id == supplier) { supplier = s.id } }
                }

                val unit = if (was?.sold_by == "weight") "Kilos" else "How many"
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
                    Labelled("Supplier's code", Modifier.weight(1.2f)) {
                        Field(supplierCode, { supplierCode = it.take(60) }, "What they call it", Modifier.fillMaxWidth(), height = 56.dp, size = 17.sp)
                    }
                    Labelled("Reorder when left", Modifier.weight(1f)) {
                        Field(reorder, { v -> reorder = v.filter { it.isDigit() || it == '.' }.take(11) }, unit, Modifier.fillMaxWidth(), height = 56.dp, number = true, size = 17.sp)
                    }
                    Labelled("Order quantity", Modifier.weight(1f)) {
                        Field(orderQty, { v -> orderQty = v.filter { it.isDigit() || it == '.' }.take(11) }, unit, Modifier.fillMaxWidth(), height = 56.dp, number = true, size = 17.sp)
                    }
                }
            }
        }

        if (page == 1 && shop && !com.restopos.core.data.Journey.alone) T("Its variants are set in the back office.", 13.sp, 500, V.Text3, lines = 2)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (was != null) VBtn("Remove", height = 52.dp, fg = V.RedText, enabled = !busy) { removing = true }
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 52.dp, enabled = !busy) { editor.close() }
            VBtn(if (busy) "Saving…" else if (was == null) "Add $thing" else "Save", bg = V.Blue, fg = Color.White, height = 52.dp, weight = 800, enabled = !busy) {
                editor.save(name, price, open, cat, barcode, onSale, count, more?.let { typed() }, start, done = done)
            }
        }
    }
}

@Composable
private fun Switch(title: String, on: Boolean, modifier: Modifier = Modifier, flip: () -> Unit) {
    Row(modifier.height(52.dp).clip(RoundedCornerShape(14.dp)).background(V.Key).press(0.99f, flip).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        T(title, 15.sp, 700, modifier = Modifier.weight(1f))
        Toggle(on)
    }
}

// A field under its name.
@Composable
private fun Labelled(label: String, modifier: Modifier = Modifier, field: @Composable ColumnScope.() -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Caps(label, V.Text2)
        field()
    }
}

// One of several to pick, on a row that slides: however many there are, the sheet keeps its height.
@Composable
private fun Picks(content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) { content() }
}

@Composable
private fun Pick(text: String, on: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.height(42.dp).clip(RoundedCornerShape(21.dp)).background(if (on) V.On else V.Key).border(1.dp, if (on) V.On else V.Stroke, RoundedCornerShape(21.dp))
            .press(onClick = onClick).padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { T(text, 14.sp, 700, if (on) V.OnText else V.Text) }
}

// The third page: the picture on this product's card. It is chosen from the
// tablet's gallery or taken with its camera, and kept at once: it is the
// tablet's own, so it does not wait for Save and nothing sends it anywhere.
// A tablet with no app to choose a picture with, or none to take one, says
// so: asking for one that is not there used to stop the till (Save a backup).
@Composable
private fun PicturePage(item: String, thing: String) {
    val pictures = com.restopos.core.ui.LocalPictures.current as? com.restopos.core.data.Pictures
    val pic = com.restopos.core.ui.pictureOf(item)
    val choose = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) pictures?.choose(item, uri)
    }
    // The whole photograph, taken into a file of the till's own, which is then made small and kept. It used
    // to ask the camera for its preview, which is a picture the size of a stamp (174 x 232 on the first try).
    val context = androidx.compose.ui.platform.LocalContext.current
    var shot by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf<android.net.Uri?>(null) }
    val shoot = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.TakePicture()) { taken ->
        val from = shot
        if (taken && from != null) pictures?.choose(item, from)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
        // in the shape the card shows it in, so what is cut off here is cut off there
        androidx.compose.foundation.layout.Box(
            Modifier.width(236.dp).aspectRatio(com.restopos.core.ui.PICTURE_SHAPE).clip(RoundedCornerShape(18.dp)).background(V.Well),
            contentAlignment = Alignment.Center,
        ) {
            if (pic == null) T("No picture yet", 14.sp, 600, V.Text3)
            else androidx.compose.foundation.Image(pic, null, Modifier.matchParentSize(), contentScale = androidx.compose.ui.layout.ContentScale.Crop)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            VBtn("Choose a picture", Modifier.fillMaxWidth(), height = 50.dp) {
                if (runCatching { choose.launch("image/*") }.isFailure) Toaster.say("This tablet has no app to choose a picture with.")
            }
            VBtn("Take a photo", Modifier.fillMaxWidth(), height = 50.dp) {
                val started = runCatching {
                    val file = java.io.File(context.cacheDir, "photos/shot.jpg").apply { parentFile?.mkdirs(); delete() }
                    val to = androidx.core.content.FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
                    shot = to
                    shoot.launch(to)
                }
                if (started.isFailure) Toaster.say("This tablet has no camera app to take one with.")
            }
            if (pic != null) VBtn("Remove the picture", Modifier.fillMaxWidth(), height = 50.dp, fg = V.Red) { pictures?.remove(item) }
        }
    }
    T("It shows along the top of this $thing's card, in this shape. It is kept on this tablet and in its backup; another till of the business does not get it.", 13.sp, 500, V.Text3, lines = 3)
}
