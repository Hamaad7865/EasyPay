package com.restopos.feature.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Money
import com.restopos.core.common.Scanner
import com.restopos.core.data.SetupFacts
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.catColor
import com.restopos.core.ui.press
import com.restopos.feature.auth.Heading
import com.restopos.feature.auth.Problem
import com.restopos.feature.auth.SetupField
import com.restopos.feature.menu.CategoryEditor
import com.restopos.feature.menu.CategorySheets
import com.restopos.feature.menu.ItemEditor
import com.restopos.feature.menu.ItemSheet

// The first step: something to sell. Categories down the left, the chosen
// one's items on the right, and one line under them to type the next item
// into, so a menu is typed down the page. Each is saved as it is added, the
// way the till's own item and category sheets save; those sheets open from
// here for anything the line does not ask.
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun MenuStep(vm: SetupViewModel, facts: SetupFacts, next: () -> Unit) {
    val shop = facts.retail
    val cats by vm.categories.collectAsState()
    val counts by vm.counts.collectAsState()
    val chosen by vm.category.collectAsState()
    val items by vm.items.collectAsState()
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    val scope = rememberCoroutineScope()
    val itemEditor = remember(shop) { ItemEditor(vm.service, vm.approvals, scope, shop) }
    val catEditor = remember(shop) { CategoryEditor(vm.service, vm.approvals, scope, shop) { gone -> if (vm.category.value == gone) vm.category.value = null } }
    val editing by itemEditor.editing.collectAsState()
    // the first category is the one on show until another is picked
    LaunchedEffect(cats, chosen) { if (chosen == null || cats.none { it.id == chosen }) vm.category.value = cats.firstOrNull()?.id }

    var newCat by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var price by rememberSaveable { mutableStateOf("") }
    var barcode by rememberSaveable { mutableStateOf("") }
    val toName = remember { FocusRequester() }
    val add = { vm.addItem(name, price, barcode) { name = ""; price = ""; barcode = ""; runCatching { toName.requestFocus() } } }

    // What an added scanner reads goes to the screens that take scans, and is
    // never typed into a box (Scanner). A shop's line has a barcode box, so
    // this step is one of those screens while it shows. Scan mode, which
    // keeps every key from the screen, is set aside here: the line is typed in.
    if (shop) {
        DisposableEffect(Unit) {
            val mode = Scanner.mode
            Scanner.mode = false
            Scanner.taking = true
            onDispose { Scanner.taking = false; Scanner.mode = mode }
        }
        LaunchedEffect(Unit) { Scanner.codes.collect { barcode = it } }
    }

    // With the tablet's keyboard up there is half a screen left, less on a low
    // tablet. The heading, the line under the lists and the foot give way, so
    // that the lists and the line being typed in keep the room.
    val typing = WindowInsets.isImeVisible
    Column(Modifier.fillMaxSize()) {
        if (!typing) {
            Heading(
                if (shop) "What do you sell?" else "What is on the menu?",
                "Add a category, then what is in it. A few are enough to start: the rest can be added at any time.",
            )
            Spacer(Modifier.height(12.dp))
        }
        problem?.let { Problem(it); Spacer(Modifier.height(10.dp)) }
        Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            // the categories
            Column(Modifier.width(250.dp).fillMaxHeight().clip(RoundedCornerShape(16.dp)).background(V.Well).padding(10.dp)) {
                Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (cats.isEmpty()) T("No categories yet", 14.sp, 500, V.Text3, Modifier.padding(10.dp))
                    cats.forEachIndexed { i, c ->
                        CategoryRow(c, i, counts[c.id] ?: 0, on = c.id == chosen, onPick = { vm.clear(); vm.category.value = c.id }, onEdit = { catEditor.open(c) })
                    }
                }
                Spacer(Modifier.height(8.dp))
                SetupField(
                    "New category", newCat, { newCat = it }, if (shop) "Clothing" else "Starters", ime = ImeAction.Done,
                    onIme = { vm.addCategory(newCat) { newCat = "" } },
                    trailing = { AddKey(busy && newCat.isNotBlank()) { vm.addCategory(newCat) { newCat = "" } } },
                )
            }
            // what is in the chosen one
            Column(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(16.dp)).background(V.Well).padding(12.dp)) {
                val cat = cats.firstOrNull { it.id == chosen }
                if (cat == null) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        T("Start with a category: Starters, Drinks, whatever you call them.", 15.sp, 500, V.Text2, lines = 3)
                    }
                } else {
                    Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
                        if (items.isEmpty()) T("Nothing in ${cat.name} yet. Type the first below.", 14.sp, 500, V.Text3, Modifier.padding(8.dp), lines = 2)
                        items.forEach { ItemRow(it) { itemEditor.open(it) } }
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                        SetupField("Name", name, { name = it }, if (shop) "Cotton scarf" else "Grilled fish", Modifier.weight(1.7f), ime = ImeAction.Next, requester = toName)
                        SetupField(
                            "Price (Rs)", price, { price = it }, "250", Modifier.weight(0.8f), keyboard = KeyboardType.Decimal,
                            ime = if (shop) ImeAction.Next else ImeAction.Done, onIme = { if (!shop) add() },
                        )
                        if (shop) SetupField("Barcode", barcode, { barcode = it }, "Scan or type", Modifier.weight(1.2f), ime = ImeAction.Done, onIme = { add() })
                        Box(
                            Modifier.height(54.dp).width(84.dp).clip(RoundedCornerShape(12.dp)).background(if (name.isBlank()) V.Key else V.Blue)
                                .then(if (busy || name.isBlank()) Modifier else Modifier.press(0.97f) { add() }),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (busy && name.isNotBlank()) CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                            else T("Add", 16.sp, 800, if (name.isBlank()) V.Text3 else Color.White)
                        }
                    }
                }
            }
        }
        if (!typing) {
            Spacer(Modifier.height(10.dp))
            T(
                if (shop) "Many products? Import a spreadsheet in the back office, under Import products."
                else "Add-ons and tax are set in the back office, under Menu.",
                13.sp, 500, V.Text3, lines = 2,
            )
            Spacer(Modifier.height(12.dp))
            if (facts.items > 0) StepFoot("Continue", ready = true, busy = false, onMain = next)
            else StepFoot(if (shop) "Add a product to go on" else "Add an item to go on", ready = false, busy = false, quiet = SKIP, onQuiet = next, onMain = {})
        }
    }
    editing?.let { ItemSheet(itemEditor, it, cats, shop) }
    CategorySheets(catEditor, cats, counts, shop)
}

// One category: its colour, its name and how many it holds. A tap shows what
// is in it; the pencil on the chosen one opens the till's own category sheet.
@Composable
private fun CategoryRow(c: CategoryEntity, place: Int, n: Int, on: Boolean, onPick: () -> Unit, onEdit: () -> Unit) {
    val colour = catColor(c.color, place)
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (on) V.RowOn else Color.Transparent).press(0.98f, onPick).padding(start = 10.dp, end = 4.dp).height(44.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(colour))
        Spacer(Modifier.width(10.dp))
        T(c.name, 15.sp, if (on) 800 else 600, if (on) V.Text else V.Dim, Modifier.weight(1f))
        T(n.toString(), 13.sp, 700, V.Text3)
        if (on) Box(Modifier.size(36.dp).press(0.92f, onEdit), contentAlignment = Alignment.Center) { VIcon(VI.Note, 15.dp, V.Text2) }
        else Spacer(Modifier.width(10.dp))
    }
}

@Composable
private fun ItemRow(item: ItemEntity, onOpen: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).press(0.99f, onOpen).padding(horizontal = 8.dp).height(42.dp), verticalAlignment = Alignment.CenterVertically) {
        T(item.name, 15.sp, 600, V.Text, Modifier.weight(1f))
        T(Money.format(item.price), 15.sp, 700, V.Text2)
    }
}

// The key at the end of the "New category" box.
@Composable
private fun AddKey(busy: Boolean, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(V.Key).press(0.94f, onClick), contentAlignment = Alignment.Center) {
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = V.Cyan, strokeWidth = 2.dp)
        else VIcon(VI.Plus, 18.dp, V.Dim)
    }
}
