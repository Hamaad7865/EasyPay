package com.restopos.core.data

// What a role may be given, by kind of business, in the words of what each
// lets someone do: the list the back office's Roles page offers
// (web/lib/perms.ts). Both are held against one file,
// db/tests/fixtures/till-office/perms.json, by a test on each side, so a
// permission added there and not here fails a test instead of going unseen.
object Perms {
    class Group(val title: String, val perms: List<Pair<String, String>>)

    fun groups(shop: Boolean): List<Group> = if (shop) RETAIL else RESTAURANT

    // every permission a sheet for that kind of business offers, in its order
    fun offered(shop: Boolean): List<String> = groups(shop).flatMap { g -> g.perms.map { it.first } }

    private val RESTAURANT = listOf(
        Group("Selling", listOf(
            "sale.create" to "Take orders",
            "payment.take" to "Take payment",
            "sale.apply_discount" to "Give a discount",
            "sale.apply_restricted_discount" to "Give a discount that needs a manager",
            "sale.void_line" to "Delete an item before it is sent to the kitchen",
            "sale.void_sent_line" to "Void an item after it was sent",
            "sale.refund" to "Refund a receipt",
            "payment.correct" to "Correct the payment type on a paid bill",
        )),
        Group("Orders and tables", listOf(
            "ticket.view_all" to "See everyone's orders",
            "ticket.reassign" to "Change the waiter on an order",
            "ticket.split_merge" to "Transfer an order to another table",
            "items.availability" to "Mark an item sold out or back on sale on the till",
        )),
        Group("Cash", listOf(
            "drawer.open_no_sale" to "Open the cash drawer without a sale",
            "cash.pay_in_out" to "Put cash in and take cash out",
            "shift.open_close" to "Open the day and close it, count the drawer",
            "shift.view_report" to "See the day's figures on the till",
        )),
        Group("Receipts", listOf(
            "receipts.view_all" to "See all receipts and the day’s payments",
            "receipts.reprint" to "Reprint receipts, bills and kitchen orders",
        )),
        Group("Back office", listOf(
            "backoffice.access" to "Sign in to the back office",
            "reports.view" to "See reports",
            "items.edit" to "Edit the menu, taxes and stock",
            "employees.edit" to "Manage staff and roles",
            "settings.device" to "Change settings, printers and tables; change how a till is set up and sign it out",
        )),
    )

    private val RETAIL = listOf(
        Group("Selling", listOf(
            "sale.create" to "Ring up sales",
            "payment.take" to "Take payment",
            "sale.apply_discount" to "Give a discount, on a sale or on one line",
            "sale.apply_restricted_discount" to "Give a discount that needs a manager",
            "sale.change_price" to "Change the price of one line of a sale",
            "sale.void_line" to "Take a line off a sale",
            "sale.void_sent_line" to "Void an item after it was sent",
            "sale.refund" to "Refund a receipt",
            "payment.correct" to "Correct the payment type on a paid bill",
        )),
        Group("Orders and tables", listOf(
            "ticket.view_all" to "See everyone's orders",
            "ticket.reassign" to "Change the waiter on an order",
            "ticket.split_merge" to "Transfer an order to another table",
            "items.availability" to "Mark an item sold out or back on sale on the till",
        )),
        Group("Cash", listOf(
            "drawer.open_no_sale" to "Open the cash drawer without a sale",
            "cash.pay_in_out" to "Put cash in and take cash out",
            "shift.open_close" to "Open the day and close it, count the drawer",
            "shift.view_report" to "See the day's figures on the till",
        )),
        Group("Receipts", listOf(
            "receipts.view_all" to "See all receipts and the day’s payments",
            "receipts.reprint" to "Reprint receipts, bills and kitchen orders",
        )),
        Group("Back office", listOf(
            "backoffice.access" to "Sign in to the back office",
            "reports.view" to "See reports",
            "items.edit" to "Edit the catalog, taxes and discounts",
            "employees.edit" to "Manage staff and roles",
            "settings.device" to "Change settings, printers and tables; change how a till is set up and sign it out",
        )),
        Group("Stock", listOf(
            "stock.view" to "See stock and its movements",
            "stock.receive" to "Order from suppliers and receive deliveries, with their costs",
            "stock.adjust" to "Adjust stock: damaged, lost, found",
            "stock.count" to "Run stock counts",
            "suppliers.edit" to "Manage suppliers",
            "costs.view" to "See cost and profit",
        )),
    )
}
