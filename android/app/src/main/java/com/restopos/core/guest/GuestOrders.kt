package com.restopos.core.guest

import com.restopos.core.data.ModPick
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ModifierEntity
import com.restopos.core.database.ModifierGroupEntity

// An order a guest sent from the code on their table (the relay,
// cloudflare/relay): which table, and for each line a dish, how many, the
// options picked and a note for the kitchen. It carries no price and no name:
// the till works both out from its own menu.
data class GuestLine(val item: String, val qty: Int, val mods: List<String>, val note: String)
data class GuestOrder(val id: String, val at: Long, val table: String, val lines: List<GuestLine>)

// What the till has, to hold an order against: its tables, its dishes, and
// for each dish the groups of options it is offered with and their options.
class MenuBook(
    val tables: Map<String, String>, // a table's id and its name
    val items: Map<String, ItemEntity>,
    val groupsOf: Map<String, List<ModifierGroupEntity>>,
    val optionsOf: Map<String, List<ModifierEntity>>, // by group
)

// A line as the cashier is shown it, and as it goes on the table's order.
data class ReadyLine(val item: ItemEntity, val qty: Int, val mods: List<ModPick>, val note: String?) {
    // The till writes a line's quantity in thousandths (a shop sells by weight):
    // two of a dish are 2000. Found by running it: an order accepted with the
    // guest's plain "2" went onto the table as two thousandths of a dish.
    val thousandths: Int get() = qty * 1000
    val unit: Long get() = item.price + mods.sumOf { it.price }
    val total: Long get() = unit * qty
}

sealed interface Checked {
    data class Ready(val table: String, val lines: List<ReadyLine>) : Checked {
        val total: Long get() = lines.sumOf { it.total }
    }
    // why it cannot be taken as it is, in words for the cashier
    data class Fault(val why: String) : Checked
}

// A guest's order held against the till's menu as it is now. The relay held
// it against the menu the till last published, and that may be a moment old:
// a dish can have sold out or left the menu since. Nothing of an order goes
// on a table until all of it can.
object GuestCheck {
    const val MOST_OF_A_DISH = 20
    const val MOST_LINES = 40

    fun of(order: GuestOrder, book: MenuBook): Checked {
        if (order.table !in book.tables) return Checked.Fault("This table is no longer on the floor plan.")
        if (order.lines.isEmpty()) return Checked.Fault("The order is empty.")
        if (order.lines.size > MOST_LINES) return Checked.Fault("The order has too many lines.")
        val ready = ArrayList<ReadyLine>()
        for (l in order.lines) {
            val item = book.items[l.item]?.takeIf { it.deleted_at == null } ?: return Checked.Fault("A dish in this order is no longer on the menu.")
            if (!item.is_available) return Checked.Fault("${item.name} is sold out.")
            if (item.open_price) return Checked.Fault("${item.name} has its price typed at the sale and cannot be ordered from a table.")
            if (l.qty !in 1..MOST_OF_A_DISH) return Checked.Fault("${item.name}: the quantity is not one that can be ordered.")
            if (l.mods.toSet().size != l.mods.size) return Checked.Fault("${item.name}: an option is there twice.")
            val left = l.mods.toMutableSet()
            val picks = ArrayList<ModPick>()
            for (g in book.groupsOf[item.id].orEmpty()) {
                val picked = book.optionsOf[g.id].orEmpty().filter { it.id in left }
                picked.forEach { left.remove(it.id); picks.add(ModPick(it.id, it.name, it.price)) }
                if (OptionRules.tooFew(g.min_select, picked.size)) return Checked.Fault("${item.name}: ${g.name} was not chosen.")
                if (OptionRules.tooMany(g.max_select, picked.size)) return Checked.Fault("${item.name}: too many of ${g.name}.")
            }
            if (left.isNotEmpty()) return Checked.Fault("${item.name}: an option is no longer offered.")
            // one line of plain words: a line break or a control byte from a phone is a space
            ready.add(ReadyLine(item, l.qty, picks, l.note.replace(NOT_WORDS, " ").trim().take(140).ifEmpty { null }))
        }
        return Checked.Ready(order.table, ready)
    }

    private val NOT_WORDS = Regex("""[\p{Cntrl}\s]+""")
}
