package com.restopos.core.data

import com.restopos.core.data.DocLines.Line
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.PurchaseOrderEntity
import com.restopos.core.database.PurchaseOrderLineEntity
import com.restopos.core.database.StockLevelEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// An order to a supplier and a delivery, as the till writes them: what is
// sent (held against the examples the server's suite sends), "Add what is
// low" by the server's rule, what is still due of an order, and the words of
// every refusal.
class OrderFormTest {
    private val order = OrderForm.Order(
        "order-1", "supplier-1", "2026-10-20", "",
        listOf(Line("item-plain", "", 12000, 4500), Line("item-sized", "variant-s", 6000, 18000)),
    )

    @Test fun `what is sent for an order is the example the server was tested with`() {
        assertEquals("po.save", StockFixtures.type("po-save"))
        assertEquals(StockFixtures.payload("po-save"), StockPayloads.poSave(order, "store-1", null))
        for (name in listOf("po-send", "po-cancel", "po-close")) assertEquals(StockFixtures.payload(name), StockPayloads.poState("order-1", null))
        assertEquals(listOf("po.send", "po.cancel", "po.close"), listOf("po-send", "po-cancel", "po-close").map { StockFixtures.type(it) })
    }

    @Test fun `two lines of one product go up as one, and someone's word goes with it`() {
        val twice = order.copy(lines = listOf(Line("item-plain", "", 3000, 4500), Line("item-plain", "", 1000, 4900)))
        val sent = StockPayloads.poSave(twice, "store-1", "emp-manager")
        assertEquals("""[{"item_id":"item-plain","variant_id":"","qty":4000,"unit_cost":4600}]""", sent["lines"].toString())
        assertEquals("\"emp-manager\"", sent["approved_by"].toString())
    }

    @Test fun `what is sent for a delivery is the example the server was tested with`() {
        // against an order the supplier is the order's: the till knows it, and sends none
        val d = DeliveryForm.Delivery("delivery-1", "order-1", "supplier-1", "2026-10-10", "INV-88", "", listOf(Line("item-plain", "", 10000, 4600)))
        assertEquals("delivery.receive", StockFixtures.type("delivery-receive"))
        assertEquals(StockFixtures.payload("delivery-receive"), StockPayloads.deliveryReceive(d, "store-1", null))
        // with no order, the supplier named goes, or none
        val loose = StockPayloads.deliveryReceive(d.copy(order = null), "store-1", null)
        assertEquals("\"\"", loose["order_id"].toString())
        assertEquals("\"supplier-1\"", loose["supplier_id"].toString())
        assertEquals("\"\"", StockPayloads.deliveryReceive(d.copy(order = null, supplier = null), "store-1", null)["supplier_id"].toString())
    }

    @Test fun `an order needs a supplier, and something on it before it is sent`() {
        assertEquals("Pick the supplier.", OrderForm.problem(order.copy(supplier = null), toSend = false))
        assertNull(OrderForm.problem(order.copy(lines = emptyList()), toSend = false))
        assertEquals("Add at least one product.", OrderForm.problem(order.copy(lines = emptyList()), toSend = true))
        assertNull(OrderForm.problem(order, toSend = true))
    }

    private fun item(id: String, supplier: String? = "sup", cost: Long? = null, track: Boolean = true, gone: Boolean = false) =
        ItemEntity(id, "t", null, id, 1000, track_stock = track, cost = cost, supplier_id = supplier, deleted_at = if (gone) "2026-10-10" else null)
    private fun variant(id: String, item: String, cost: Long? = null, gone: Boolean = false) = ItemVariantEntity(id, "t", item, id, 1000, cost = cost, deleted_at = if (gone) "2026-10-10" else null)
    private fun level(item: String, variant: String, qty: Int, point: Int?, order: Int? = null, avg: Double = 0.0) =
        StockLevelEntity("store", item, variant, qty, avg_cost = avg, reorder_point = point, reorder_qty = order)

    @Test fun `a line starts at what the product last cost`() {
        assertEquals(6200L, OrderForm.startCost(item("a", cost = 5000), variant("m", "a", cost = 6200), level("a", "m", 0, null, avg = 4000.0)))
        assertEquals(5000L, OrderForm.startCost(item("a", cost = 5000), variant("m", "a"), level("a", "m", 0, null, avg = 4000.0)))
        assertEquals(4534L, OrderForm.startCost(item("a"), null, level("a", "", 0, null, avg = 4533.6)))
        assertEquals(0L, OrderForm.startCost(item("a"), null, null))
    }

    @Test fun `add what is low, by the server's rule`() {
        val items = listOf(
            item("at"), item("below"), item("above"), item("on-draft"), item("theirs", supplier = "other"), item("order-qty"),
            item("short-400"), item("short-2500"), item("no-level"), item("no-point"), item("fee", track = false), item("gone", gone = true), item("sized"),
        )
        val variants = listOf(variant("s", "sized"), variant("m", "sized"), variant("old", "sized", gone = true))
        val levels = listOf(
            level("at", "", 4000, 4000, avg = 4533.6), level("below", "", 1000, 4000, avg = 100.4), level("above", "", 5000, 4000),
            level("on-draft", "", 0, 4000), level("theirs", "", 0, 4000), level("order-qty", "", 0, 4000, order = 24000, avg = 0.0),
            level("short-400", "", 3600, 4000), level("short-2500", "", 1500, 4000), level("no-point", "", 0, null),
            level("fee", "", 0, 4000), level("gone", "", 0, 4000),
            // a product with variants holds its stock on them: its own row is no line of stock
            level("sized", "", 0, 4000), level("sized", "s", 0, 2000, avg = 6200.0), level("sized", "m", 9000, 2000), level("sized", "old", 0, 2000),
        )
        val low = PoFill.low("sup", listOf(Line("on-draft", "", 1000, 1)), items, variants, levels) { it.track_stock }
        assertEquals(
            listOf(
                Line("at", "", 1000, 4534), // at its level: nothing is short, and never less than one unit
                Line("below", "", 3000, 100), // what brings it back to its level
                Line("order-qty", "", 24000, 0), // its own order quantity
                Line("short-400", "", 1000, 0),
                Line("short-2500", "", 2500, 0),
                Line("sized", "s", 2000, 6200),
            ),
            low,
        )
    }

    @Test fun `a delivery for an order starts as what is still due of it`() {
        val o = PurchaseOrderEntity("o", "store", "PO-0001", "sup", "part")
        val lines = listOf(PurchaseOrderLineEntity("o", "a", "", 12000, 4500, received = 10000), PurchaseOrderLineEntity("o", "b", "m", 6000, 18000, received = 6000), PurchaseOrderLineEntity("o", "c", "", 3000, 100))
        val d = DeliveryForm.fromOrder("d", o, lines, "2026-10-11")
        assertEquals(DeliveryForm.Delivery("d", "o", "sup", "2026-10-11", lines = listOf(Line("a", "", 2000, 4500), Line("c", "", 3000, 100))), d)
        assertEquals("Nothing has been received yet.", DeliveryForm.problem(d.copy(lines = emptyList())))
        assertNull(DeliveryForm.problem(d))
    }

    @Test fun `labels for what arrived are one a whole unit, and one for a line sold by weight`() {
        val lines = listOf(Line("three", "", 3000, 1), Line("two-and-a-half", "", 2500, 1), Line("under-one", "", 400, 1), Line("rice", "", 5000, 1), Line("many", "", 500_000, 1), Line("none", "", 0, 1))
        val got = DeliveryForm.labels(lines) { if (it == "rice") "weight" else "each" }
        assertEquals(listOf("three" to 3, "two-and-a-half" to 2, "under-one" to 1, "rice" to 1, "many" to LabelList.MOST_EACH), got.map { it.first.item to it.second })
    }

    @Test fun `every refusal has its own sentence`() {
        val forOrders = listOf("unknown-supplier", "unknown-store", "unknown-order", "not-draft", "no-lines", "already-received", "not-open", "not-part",
            "unknown-item", "not-counted", "pick-variant", "unknown-line", "bad-line", "forbidden", "conflict", "unknown-op")
        val said = forOrders.map { OrderForm.refused(it) }
        assertEquals(said.size, said.toSet().size)
        assertTrue(said.none { it.startsWith("The server refused it") })
        val forDeliveries = listOf("nothing-received", "not-open", "unknown-order", "unknown-supplier", "unknown-store", "bad-delivery",
            "unknown-item", "not-counted", "pick-variant", "unknown-line", "bad-line", "forbidden", "unknown-op")
        assertTrue(forDeliveries.map { DeliveryForm.refused(it) }.none { it.startsWith("The server refused it") })
        assertEquals("The server refused it.", OrderForm.refused(null))
        assertEquals("The server refused it (new-code).", DeliveryForm.refused("new-code"))
    }
}
