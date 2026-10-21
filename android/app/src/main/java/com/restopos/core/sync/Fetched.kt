package com.restopos.core.sync

import com.restopos.core.database.StockLevelEntity

// What a tablet that works on its own takes when it is asked to fetch
// ("Get changes from EasyPay", Settings, Support), and what it says of it.
//
// An offline business has no back office of its own, but EasyPay has one for
// it: the products, the taxes, the staff and the rest are typed there on a
// computer, for the business's owner, the day it is set up and whenever it
// asks. The tablet does not sync, so none of that reaches it by itself: the
// key asks the server once, takes what changed there since the tablet last
// asked, and goes on working on its own. It is the same question "Connect to
// the cloud" asks, and nothing is sent up by either while the plan is
// offline.
//
// What the server holds of an offline business is what was set up, never
// what the business did: its sales and its stock are on the tablet alone. So
// a row the server sends replaces the tablet's row of the same thing, except
// where the tablet's is the only true one (level, below; OwnSettings for the
// settings the tablet changed itself).
object Fetched {
    // A stock level the server sends to a tablet that works on its own. The
    // server's figure is the opening one, less nothing: every sale since was
    // counted on the tablet only. So the tablet's count and its average cost
    // stay, and what is set up beside them (when to order again, and how
    // much) is taken. A level the tablet has none of is taken whole: a new
    // product's opening stock.
    fun level(own: StockLevelEntity?, sent: StockLevelEntity): StockLevelEntity =
        if (own == null) sent else sent.copy(qty = own.qty, avg_cost = own.avg_cost)

    // A customer the server sends (0128): their name, phone, card and note are
    // what was set up for them there, and are taken; their points were earned
    // and spent on the tablet alone, so the tablet's balance stays. One the
    // tablet has none of comes with what the server holds (nothing, for an
    // offline business).
    fun customer(own: com.restopos.core.database.CustomerEntity?, sent: com.restopos.core.database.CustomerEntity): com.restopos.core.database.CustomerEntity =
        if (own == null) sent else sent.copy(points = own.points)

    // What a pull brought, in the till's words, from the tables it had rows
    // of: "products, taxes and staff". Null when it brought nothing anyone
    // set up (the server's own note that a till asked is not a change).
    fun said(tables: Set<String>, shop: Boolean): String? {
        val words = NAMES.filter { (from, _) -> from.any { it in tables } }.map { (_, word) -> if (word == MENU) (if (shop) "products" else "the menu") else word }
        return when (words.size) {
            0 -> null
            1 -> words[0]
            else -> words.dropLast(1).joinToString(", ") + " and " + words.last()
        }
    }

    private const val MENU = "menu"
    private val NAMES: List<Pair<Set<String>, String>> = listOf(
        setOf("items", "item_variants", "item_taxes", "item_modifier_groups") to MENU,
        setOf("categories") to "categories",
        setOf("modifier_groups", "modifiers") to "add-ons",
        setOf("taxes") to "taxes",
        setOf("discounts") to "discounts",
        setOf("employees", "employee_stores") to "staff",
        setOf("roles") to "roles",
        setOf("printers") to "printers",
        setOf("tables", "floor_elements") to "tables",
        setOf("payment_types") to "payment types",
        setOf("dining_options") to "order types",
        setOf("suppliers") to "suppliers",
        setOf("customers") to "customers",
        setOf("pos_settings") to "settings",
    )

    // What the till says once the server has been asked.
    //   fetching   the key was "Get changes from EasyPay" (false: "Connect to the cloud")
    //   connected  the business is on Premium now: the tablet no longer works on its own
    //   signIn     the tablet has no key of its own and has to sign in before it can ask
    //   done       the server answered; finished: the asking is over, answered or not
    //   brought    what came with the answer (said, above), or null
    fun answer(fetching: Boolean, connected: Boolean, signIn: Boolean, done: Boolean, finished: Boolean, brought: String?): String = when {
        connected -> "This business is on Premium: the tablet is connected, and what it kept is being sent to the cloud."
        signIn -> "This tablet has to sign in once before it can ask EasyPay. Tap Sign in, with the login of this business, then " +
            (if (fetching) "Get changes from EasyPay" else "Connect to the cloud") + " again."
        done && fetching && brought != null -> "From EasyPay: $brought. It is on this tablet now, and the tablet goes on working on its own."
        done && fetching -> "Nothing new from EasyPay. This tablet has everything that was set up for it."
        done && brought != null -> "This business is not on Premium: the tablet goes on working on its own. EasyPay had changes for it ($brought): they are here now."
        done -> "This business is not on Premium. Nothing has changed: the tablet goes on working on its own."
        finished -> "EasyPay could not be reached. Try again when the tablet is online."
        else -> "No answer yet. The tablet asks again as soon as it is online."
    }
}
