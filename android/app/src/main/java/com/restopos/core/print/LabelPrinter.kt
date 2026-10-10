package com.restopos.core.print

import com.restopos.core.data.PrinterForm
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// The printer the labels come out of. It belongs to the tablet it is plugged
// into or paired with, like a scanner, not to the business: it is kept on the
// tablet (SessionStore) and never sent anywhere, and it is not one of the
// store's printers, so no receipt, ticket or report can be sent to it.
@Serializable
data class LabelPrinter(
    val name: String,
    // network | usb | bluetooth, as a store's printer
    val kind: String,
    // ip or ip:port, or the Bluetooth address; a USB printer has none
    val address: String? = null,
    // what it speaks: TSPL (a sticker printer) or ESC/POS (a receipt-type printer loaded with stickers)
    val language: String = TSPL,
    // a sticker printer's dots an inch: 203 on nearly all of them, 300 on some
    val dpi: Int = 203,
    // a receipt-type printer's paper, in mm
    val paper: Int = 80,
    // which USB device it is, so that it is never taken for the receipt printer on the other cable
    val usbVendor: Int? = null,
    val usbProduct: Int? = null,
    val usbName: String? = null,
    val usbSerial: String? = null,
) {
    val sticker: Boolean get() = language != ESCPOS
    // the dots it prints an inch: a receipt printer's are always 203
    val dots: Int get() = if (sticker) dpi else 203

    companion object {
        const val TSPL = "tspl"
        const val ESCPOS = "escpos"
        // its id where a printer has to have one (the list of print jobs)
        const val ID = "label-printer"
    }
}

object LabelPrinters {
    private val json = Json { ignoreUnknownKeys = true }

    const val PICK_USB = "Pick the printer among what is plugged into this tablet"

    // What the tablet kept, or none: text that cannot be read is no printer,
    // and it only has to be set up again.
    fun read(text: String?): LabelPrinter? =
        if (text.isNullOrBlank()) null
        else runCatching { json.decodeFromString(LabelPrinter.serializer(), text) }.getOrNull()?.takeIf { it.name.isNotBlank() }

    fun write(p: LabelPrinter): String = json.encodeToString(LabelPrinter.serializer(), p)

    // What the form holds, read as a label printer, or why it is not one yet.
    // Its name and how it is reached follow a store's printer's rules.
    fun form(name: String, kind: String, address: String, language: String, dpi: Int, paper: Int, usb: UsbPick.Seen?): Result<LabelPrinter> = runCatching {
        // a USB printer is told by which device it is, not by anything typed
        if (kind == PrinterForm.USB) {
            require(name.trim().isNotEmpty()) { "Give the printer a name" }
            requireNotNull(usb) { PICK_USB }
        }
        val p = PrinterForm.read(name, kind, address, paper).getOrThrow()
        LabelPrinter(
            p.name, p.kind, p.address,
            language = if (language == LabelPrinter.ESCPOS) LabelPrinter.ESCPOS else LabelPrinter.TSPL,
            dpi = if (dpi == 300) 300 else 203,
            paper = p.paper,
            usbVendor = usb?.takeIf { p.kind == PrinterForm.USB }?.vendor,
            usbProduct = usb?.takeIf { p.kind == PrinterForm.USB }?.product,
            usbName = usb?.takeIf { p.kind == PrinterForm.USB }?.name,
            usbSerial = usb?.takeIf { p.kind == PrinterForm.USB }?.serial,
        )
    }
}

// Which USB device is which. The till used to print on the first USB printer
// it found; with a receipt printer and a label printer both on cables, either
// could have had the other's job. Nothing here knows about Android: the
// devices are handed over as what the tablet says of each.
object UsbPick {
    // A printer plugged into the tablet: its maker's and product's numbers,
    // the name it gives itself, and its serial number when the tablet tells it
    // (it does not before the person at the till has allowed the device).
    data class Seen(val vendor: Int, val product: Int, val name: String?, val serial: String?)

    private fun same(a: Seen, vendor: Int?, product: Int?) = a.vendor == vendor && a.product == product

    // The label printer among what is plugged in, or null: not plugged in, or
    // not a USB printer at all. Where both serial numbers are known they have
    // to agree; among several left, the one of the same name, else the first.
    fun match(p: LabelPrinter, seen: List<Seen>): Seen? {
        if (p.kind != "usb" || p.usbVendor == null || p.usbProduct == null) return null
        val left = seen.filter { same(it, p.usbVendor, p.usbProduct) && (p.usbSerial == null || it.serial == null || it.serial == p.usbSerial) }
        return left.firstOrNull { p.usbSerial != null && it.serial == p.usbSerial }
            ?: left.firstOrNull { it.name == p.usbName }
            ?: left.firstOrNull()
    }

    // Whether another printer plugged in cannot be told from `pick`: the same
    // numbers, and no two serial numbers to tell them apart by.
    fun twins(pick: Seen, seen: List<Seen>): Boolean {
        var met = false
        for (s in seen) {
            if (!same(s, pick.vendor, pick.product)) continue
            if (!met && s == pick) { met = true; continue } // itself, once
            if (s.serial == null || pick.serial == null || s.serial == pick.serial) return true
        }
        return false
    }

    // Where receipts, reports and tickets go by USB: the first printer that is
    // not the label printer.
    fun receipt(seen: List<Seen>, label: LabelPrinter?): Seen? {
        val its = label?.let { match(it, seen) } ?: return seen.firstOrNull()
        var skipped = false
        return seen.firstOrNull { s -> if (!skipped && s == its) { skipped = true; false } else true }
    }
}
