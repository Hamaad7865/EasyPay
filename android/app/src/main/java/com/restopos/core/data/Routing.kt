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

    // The one printer that does everything, when the restaurant is set up that
    // way and has a receipt printer. Set that way without one, the categories'
    // own printers are used: an order must not print nowhere because of a switch.
    fun single(printers: List<PrinterEntity>, onePrinter: Boolean): PrinterEntity? =
        if (onePrinter) printers.firstOrNull { it.is_receipt } else null

    // The printers a category's items print on, in the order the printers are
    // listed. `ticked` is the category's own list (null for an item with no
    // category); what it names that is not a usable printer is left out.
    fun printersFor(ticked: List<String>?, printers: List<PrinterEntity>, onePrinter: Boolean): List<String> {
        single(printers, onePrinter)?.let { return listOf(it.id) }
        val wanted = ticked.orEmpty().toSet()
        return printers.filter { wanted.contains(it.id) }.map { it.id }
    }

    // An order's lines, as the tickets they make: printer to its lines, each
    // line once per printer and in the order it was rung up. A line with
    // nowhere to print is on no ticket (it is still on the kitchen display).
    fun <L> tickets(lines: List<Pair<L, List<String>?>>, printers: List<PrinterEntity>, onePrinter: Boolean): Map<String, List<L>> {
        val out = LinkedHashMap<String, MutableList<L>>()
        printers.forEach { out[it.id] = ArrayList() }
        lines.forEach { (line, ticked) -> printersFor(ticked, printers, onePrinter).forEach { out.getValue(it).add(line) } }
        return out.filterValues { it.isNotEmpty() }
    }

    // The kitchen display's stations: the printers where something is made,
    // which is every printer that has a category and is not the cashier's.
    // With one printer for everything there is one place, so no stations.
    fun stations(categories: Collection<List<String>>, printers: List<PrinterEntity>, onePrinter: Boolean): List<PrinterEntity> {
        if (single(printers, onePrinter) != null) return emptyList()
        val used = categories.flatten().toSet()
        return printers.filter { !it.is_receipt && used.contains(it.id) }
    }

    // The stations a category's items show under on the kitchen display.
    fun stationsFor(ticked: List<String>?, stations: List<PrinterEntity>): Set<String> {
        val wanted = ticked.orEmpty().toSet()
        return stations.filter { wanted.contains(it.id) }.map { it.id }.toSet()
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
    // to it are sent one after the other, never two at once.
    fun line(p: PrinterEntity): String =
        if (p.kind == "usb") "usb" else {
            val address = p.address?.trim().orEmpty().lowercase()
            address.substringBefore(':') + ":" + (address.substringAfter(':', "9100").toIntOrNull() ?: 9100)
        }
}
