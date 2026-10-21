package com.restopos.core.data

import com.restopos.core.database.PrinterEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

// Where an order's items print. Kept apart from the database and from the
// printers themselves so that it can be checked on its own: every ticket the
// kitchen gets, every void, every reprint and the kitchen display's stations
// are worked out here and nowhere else.
//
// Two ways a restaurant is set up (back office, Printers):
//   - a printer where each thing is made: a category's items print on the
//     printers ticked for it, one ticket per printer;
//   - one printer for everything: every kitchen order prints on the receipt
//     printer, whatever is ticked on the categories, so a category added
//     later is covered without anyone having to remember it.
object Routing {
    // The printers this till may print on: this store's, not removed, switched on.
    fun usable(all: List<PrinterEntity>, store: String?): List<PrinterEntity> =
        all.filter { it.store_id == store && it.deleted_at == null && it.is_active }

    // A kitchen screen (server 0086) is kept with the printers and ticked like
    // one, and is not one: a tablet that shows the orders. Everything below
    // that prints works on the paper alone, whatever list it is handed, so a
    // screen can never be sent a printer's bytes.
    fun paper(all: List<PrinterEntity>): List<PrinterEntity> = all.filter { !silent(it.kind) }
    fun screens(all: List<PrinterEntity>): List<PrinterEntity> = all.filter { it.kind == SCREEN }

    // A customer display (server 0129) is kept with the printers too, and is
    // neither a printer nor a kitchen screen: a tablet that faces the
    // customer and shows one till's sale. A kind that prints nothing is never
    // in a list of paper, never the receipt printer, never ticked.
    fun silent(kind: String): Boolean = kind == SCREEN || kind == DISPLAY

    // The displays a till shows its sale on: those facing it, switched on.
    fun displays(all: List<PrinterEntity>, device: String?): List<PrinterEntity> =
        if (device == null) emptyList() else all.filter { it.kind == DISPLAY && it.is_active && it.deleted_at == null && it.device_id == device }

    // The one printer that does everything, when the restaurant is set up that
    // way and has a receipt printer. Set that way without one, the categories'
    // own printers are used: an order must not print nowhere because of a switch.
    fun single(printers: List<PrinterEntity>, onePrinter: Boolean): PrinterEntity? =
        if (onePrinter) paper(printers).firstOrNull { it.is_receipt } else null

    // The printers a category's items print on, in the order the printers are
    // listed. `ticked` is the category's own list (null for an item with no
    // category); what it names that is not a usable printer is left out.
    fun printersFor(ticked: List<String>?, printers: List<PrinterEntity>, onePrinter: Boolean): List<String> {
        single(printers, onePrinter)?.let { return listOf(it.id) }
        val wanted = ticked.orEmpty().toSet()
        return paper(printers).filter { wanted.contains(it.id) }.map { it.id }
    }

    // An order's lines, as the tickets they make: printer to its lines, each
    // line once per printer and in the order it was rung up. A line with
    // nowhere to print is on no ticket (it is still on the kitchen display).
    fun <L> tickets(lines: List<Pair<L, List<String>?>>, printers: List<PrinterEntity>, onePrinter: Boolean): Map<String, List<L>> {
        val out = LinkedHashMap<String, MutableList<L>>()
        paper(printers).forEach { out[it.id] = ArrayList() }
        lines.forEach { (line, ticked) -> printersFor(ticked, printers, onePrinter).forEach { out.getValue(it).add(line) } }
        return out.filterValues { it.isNotEmpty() }
    }

    // An order's lines, as each kitchen screen's part of them: screen to its
    // lines, in the order they were rung up. A screen set to show everything
    // takes every line, the ones with no category included; another takes
    // the lines of the categories that tick it. A screen with nothing of this
    // send is sent nothing. "One printer for everything" speaks for the paper
    // only: a screen goes by its own setting.
    fun <L> screenLines(lines: List<Pair<L, List<String>?>>, screens: List<PrinterEntity>): Map<String, List<L>> {
        val only = screens(screens)
        val out = LinkedHashMap<String, MutableList<L>>()
        only.forEach { out[it.id] = ArrayList() }
        lines.forEach { (line, ticked) ->
            val wanted = ticked.orEmpty().toSet()
            only.forEach { s -> if (s.all_items || wanted.contains(s.id)) out.getValue(s.id).add(line) }
        }
        return out.filterValues { it.isNotEmpty() }
    }

    // The lines that print nowhere: no printer ticked for their category, or
    // none of the ticked ones usable. With a kitchen display they are still
    // on it. A restaurant without one (the display is the premium tier's) has
    // only its paper, so the till names them: nobody else would.
    fun <L> nowhere(lines: List<Pair<L, List<String>?>>, printers: List<PrinterEntity>, onePrinter: Boolean): List<L> =
        lines.filter { (_, ticked) -> printersFor(ticked, printers, onePrinter).isEmpty() }.map { it.first }

    // The lines that reach the kitchen nowhere: no paper takes them and no
    // kitchen screen shows them. They are on the till's own Kitchen tab only,
    // which is not where the kitchen looks, so the till names them on every
    // plan. (Until 2026-10-20 a Premium till said nothing, as if that tab were
    // the kitchen: a category added with nothing ticked was "sent" and never made.)
    fun <L> unseen(lines: List<Pair<L, List<String>?>>, printers: List<PrinterEntity>, screens: List<PrinterEntity>, onePrinter: Boolean): List<L> {
        val shown = screenLines(lines.mapIndexed { i, (_, ticked) -> i to ticked }, screens).values.flatten().toSet()
        return lines.filterIndexed { i, (_, ticked) -> printersFor(ticked, printers, onePrinter).isEmpty() && i !in shown }.map { it.first }
    }

    // What the till says about them: how many lines, and each name once.
    // `screens`: the restaurant has kitchen screens, so they are named too.
    fun nowhereText(names: List<String>, screens: Boolean = false): String? {
        if (names.isEmpty()) return null
        val n = names.size
        val where = if (screens) "no printer or kitchen screen" else "no printer"
        return "$n ${if (n == 1) "item" else "items"} went to $where: ${names.distinct().joinToString(", ")}. " +
            if (Journey.alone) "Switch on \"Kitchen orders print on it too\" for the printer: Settings, This till, Set-up, Printer."
            else "Tick a printer${if (screens) " or a kitchen screen" else ""} for ${if (n == 1) "its" else "their"} category in the back office."
    }

    // The kitchen display's stations: the printers where something is made,
    // which is every printer that has a category and is not the cashier's
    // (with one printer for everything the paper is one place, so none), and
    // after them every kitchen screen, whatever it is set to show.
    fun stations(categories: Collection<List<String>>, printers: List<PrinterEntity>, onePrinter: Boolean): List<PrinterEntity> {
        val used = categories.flatten().toSet()
        val made = if (single(printers, onePrinter) != null) emptyList() else paper(printers).filter { !it.is_receipt && used.contains(it.id) }
        return made + screens(printers)
    }

    // The stations a category's items show under on the kitchen display. A
    // screen that shows everything has every line under it.
    fun stationsFor(ticked: List<String>?, stations: List<PrinterEntity>): Set<String> {
        val wanted = ticked.orEmpty().toSet()
        return stations.filter { wanted.contains(it.id) || (it.kind == SCREEN && it.all_items) }.map { it.id }.toSet()
    }

    // What the top of a kitchen ticket says: where it is for, or, when it
    // shares its paper with the bills, that it is a kitchen order.
    fun heading(printer: PrinterEntity, printers: List<PrinterEntity>, onePrinter: Boolean): String =
        if (single(printers, onePrinter) != null) "Kitchen order" else printer.name

    // A category's printers as they are kept: a JSON list of ids.
    fun ids(text: String?): List<String> =
        runCatching { Json.parseToJsonElement(text ?: "[]").jsonArray.map { it.jsonPrimitive.content } }.getOrDefault(emptyList())

    // One printer as the wire sees it, however many times it was entered in
    // the back office ("Receipt" and "Kitchen" at the same address): prints
    // to it are sent one after the other, never two at once. A kitchen screen
    // is at its own address and port, and has one exchange at a time too.
    fun line(p: PrinterEntity): String =
        if (p.kind == "usb") "usb"
        // a Bluetooth printer by the name or address it is looked for by (an address has colons of its own)
        else if (p.kind == "bluetooth") "bluetooth:" + p.address?.trim().orEmpty().lowercase()
        else {
            val port = when (p.kind) { SCREEN -> 9310; DISPLAY -> 9311; else -> 9100 }
            val address = p.address?.trim().orEmpty().lowercase()
            address.substringBefore(':') + ":" + (address.substringAfter(':', port.toString()).toIntOrNull() ?: port)
        }

    const val SCREEN = "screen"
    const val DISPLAY = "display"
}
