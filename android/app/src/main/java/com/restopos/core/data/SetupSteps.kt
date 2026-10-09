package com.restopos.core.data

// The first-run set-up (server 0089): what a new business is walked through
// on its tablet, one step a screen, and the summary it ends on. Which steps a
// business has, which of them are done and what the summary says of each are
// decided here, with no screen, so that they can be tested.

enum class SetupStep { Menu, Tables, Printer, Company, Staff }

// What the business has, as far as the set-up asks.
// printers: their names, the one that prints the receipts first; a kitchen
// screen is not a printer.
data class SetupFacts(
    val retail: Boolean = false,
    val items: Int = 0,
    val categories: Int = 0,
    val tables: Int = 0,
    val rooms: Int = 0,
    val printers: List<String> = emptyList(),
    val address: String = "",
    val phone: String = "",
    val pins: Int = 0,
)

object SetupSteps {
    // A shop has no tables. Staff and PINs comes last: once anyone has a PIN
    // the start screen asks for one, so nothing of the set-up is left after it.
    fun of(retail: Boolean): List<SetupStep> = SetupStep.values().filter { !retail || it != SetupStep.Tables }

    // A step is done when its work exists, whoever did it and wherever:
    // products imported in the back office count as those typed here.
    fun done(step: SetupStep, f: SetupFacts): Boolean = when (step) {
        SetupStep.Menu -> f.items > 0
        SetupStep.Tables -> f.tables > 0
        SetupStep.Printer -> f.printers.isNotEmpty()
        SetupStep.Company -> f.address.isNotBlank() || f.phone.isNotBlank()
        SetupStep.Staff -> f.pins > 0
    }

    // Where a first run starts: the first step that is not done. Null when all are.
    fun first(f: SetupFacts): SetupStep? = of(f.retail).firstOrNull { !done(it, f) }

    fun title(step: SetupStep, retail: Boolean): String = when (step) {
        SetupStep.Menu -> if (retail) "Products" else "Menu"
        SetupStep.Tables -> "Tables"
        SetupStep.Printer -> "Printer"
        SetupStep.Company -> "Business details"
        SetupStep.Staff -> "Staff and PINs"
    }

    private fun count(n: Int, one: String, many: String) = "$n " + if (n == 1) one else many

    // The summary's words for a step: what is there, or what its absence means.
    fun line(step: SetupStep, f: SetupFacts): String = when (step) {
        SetupStep.Menu -> when {
            f.items <= 0 -> "Nothing to sell yet"
            else -> count(f.items, if (f.retail) "product" else "item", if (f.retail) "products" else "items") +
                if (f.categories > 0) " in " + count(f.categories, "category", "categories") else ""
        }
        SetupStep.Tables ->
            if (f.tables <= 0) "No tables: orders are counter sales and takeaways"
            else count(f.tables, "table", "tables") + " in " + count(f.rooms.coerceAtLeast(1), "room", "rooms")
        SetupStep.Printer -> when {
            f.printers.isEmpty() -> "No printer: nothing prints and the cash drawer stays shut"
            f.printers.size == 1 -> f.printers.first()
            else -> "${f.printers.first()} and ${f.printers.size - 1} more"
        }
        SetupStep.Company ->
            f.address.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }
                ?: f.phone.trim().ifEmpty { "No address or phone on the receipt" }
        SetupStep.Staff ->
            if (f.pins <= 0) "No PINs: the register opens with one tap"
            else count(f.pins, "person has", "people have") + " a PIN"
    }

    // After "Name this till". A tablet that was just registered holds nothing
    // of the business: its tables fill with its first pull. So nothing is
    // decided until a whole pull has finished since it was registered
    // (SessionStore.lastPull is written only then). After that the business's
    // own mark says whether its set-up is still open.
    enum class After { Wait, SetUp, Till }

    fun after(registeredAt: Long, lastPull: Long?, settings: PosSettings): After = when {
        lastPull == null || lastPull < registeredAt -> After.Wait
        settings.setupOpen -> After.SetUp
        else -> After.Till
    }
}
