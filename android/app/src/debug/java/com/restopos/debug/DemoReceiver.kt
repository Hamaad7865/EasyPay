package com.restopos.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.room.withTransaction
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.DeviceEntity
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.EmployeeStoreEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemTaxCrossRef
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.RoleEntity
import com.restopos.core.database.SettingsEntity
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.StoreEntity
import com.restopos.core.database.TaxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

// DEBUG BUILDS ONLY. Fills a tablet that was never set up with the made-up
// shop of assets/demo-shop.json: a store, a till, two members of staff, a
// catalog with variants and what the shop holds of each. The shop's screens
// can then be used on an emulator with no login and no server; what is sold
// waits in the outbox, as on a till that is offline.
// db/scripts/replay-demo-outbox.cjs reads the same file and sends that
// outbox to the dev server, in a transaction that is rolled back.
//
// It refuses a tablet that is set up for a business: it never writes over one.
class DemoReceiver : BroadcastReceiver() {
    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun db(): TillDatabase
        fun session(): SessionStore
        fun applier(): com.restopos.core.sync.PullApplier
    }

    override fun onReceive(context: Context, intent: Intent) {
        // A scan with no scanner (an emulator has none, and keys typed on a PC
        // are too slow to be taken for one): the code goes where a scan goes.
        //   adb shell am broadcast -n com.restopos.app/com.restopos.debug.DemoReceiver -a com.restopos.app.DEMO_SCAN --es code S1-T1-000123
        if (intent.action == SCAN) {
            intent.getStringExtra("code")?.trim()?.takeIf { it.isNotEmpty() }?.let { com.restopos.core.common.Scanner.scanned(it) }
            return
        }
        val pending = goAsync()
        val deps = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
        CoroutineScope(Dispatchers.IO).launch {
            try {
                if (intent.action == PULL) {
                    // A page of the pull, as the server sent it (files/demo-page.json), goes through the
                    // till's own reader: the way a real till gets its catalog, stock and receipts.
                    //   adb shell am broadcast -n com.restopos.app/com.restopos.debug.DemoReceiver -a com.restopos.app.DEMO_PULL
                    // Only on the made-up business: never onto a tablet set up for a real one.
                    val shop = Json.parseToJsonElement(context.assets.open("demo-shop.json").bufferedReader().use { it.readText() })
                    val store = deps.session().storeId()
                    if (store == null || deps.session().tenantId() != shop.str("tenant")) Log.w(TAG, "refused: this tablet is not the made-up business")
                    else {
                        val page = Json.parseToJsonElement(java.io.File(context.filesDir, "demo-page.json").readText())
                        val changes = page.obj("changes").mapValues { it.value.jsonArray.toList() }
                        deps.applier().apply(store, changes, page.lng("next_cursor"), "")
                        Log.i(TAG, "pulled: " + changes.filter { it.value.isNotEmpty() }.map { it.key + " " + it.value.size }.joinToString(", "))
                    }
                } else if (deps.session().isSetUp()) Log.w(TAG, "refused: this tablet is set up for a business")
                else if (intent.getBooleanExtra("session_only", false)) {
                    // --ez session_only true: only which business, store and till this tablet is; everything else is to come by the pull
                    val shop = Json.parseToJsonElement(context.assets.open("demo-shop.json").bufferedReader().use { it.readText() })
                    deps.session().save(shop.str("tenant")!!, shop.obj("store").str("id")!!, shop.obj("device").str("id")!!)
                    deps.session().setBusinessName(shop.obj("store").str("name")!!)
                    Log.i(TAG, "set up as the made-up business, with nothing in it yet")
                } else {
                    // --es type restaurant: the same catalog as a restaurant's, with tables and order types
                    val restaurant = intent.getStringExtra("type") == "restaurant"
                    // --es plan standard (or premium): the plan the settings carry (server 0085).
                    // Standard has no Kitchen and no Bookings screen. Left out, the settings carry
                    // none, as before there were plans, and the till shows everything.
                    val plan = intent.getStringExtra("plan")?.trim()?.takeIf { it.isNotEmpty() }
                    // --es screen 10.0.2.2:9310: a kitchen screen at that address, showing everything, with
                    // the pairing code every debug build's kitchen tablet has (AppNav). From one emulator the
                    // PC is 10.0.2.2; "adb forward tcp:9310 tcp:9310" on the kitchen's emulator joins the two.
                    val screen = intent.getStringExtra("screen")?.trim()?.takeIf { it.isNotEmpty() && restaurant }
                    seed(context, deps.db(), deps.session(), restaurant, plan)
                    if (screen != null) {
                        val shop = Json.parseToJsonElement(context.assets.open("demo-shop.json").bufferedReader().use { it.readText() })
                        deps.db().ops().upsertPrinters(listOf(
                            com.restopos.core.database.PrinterEntity(
                                id = "d0000000-0000-4000-8000-0000000000c1", tenant_id = shop.str("tenant")!!, store_id = shop.obj("store").str("id")!!,
                                name = "Kitchen", kind = "screen", address = screen, pair_code = "KTCHN234", all_items = true,
                            ),
                        ))
                    }
                    Log.i(TAG, "seeded a " + (if (restaurant) "restaurant" else "shop") + (plan?.let { " on the $it plan" } ?: "") + ": close the app and open it again")
                }
            } catch (e: Exception) {
                Log.e(TAG, "failed", e)
            } finally {
                pending.finish()
            }
        }
    }

    private fun JsonElement.str(k: String): String? = jsonObject[k]?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.jsonPrimitive?.contentOrNull
    private fun JsonElement.lng(k: String): Long = jsonObject[k]?.jsonPrimitive?.longOrNull ?: 0
    private fun JsonElement.bool(k: String): Boolean = jsonObject[k]?.jsonPrimitive?.booleanOrNull ?: false
    private fun JsonElement.arr(k: String): JsonArray = jsonObject[k]?.jsonArray ?: JsonArray(emptyList())
    private fun JsonElement.obj(k: String): JsonObject = jsonObject[k]!!.jsonObject

    // the hash the till checks a PIN against (PinHash), as the back office would have stored it
    private fun pinHash(pin: String, salt: ByteArray): String {
        val iterations = 2000
        val hash = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(PBEKeySpec(pin.toCharArray(), salt, iterations, 256)).encoded
        val b64 = Base64.getEncoder()
        return listOf("pbkdf2-sha256", iterations.toString(), b64.encodeToString(salt), b64.encodeToString(hash)).joinToString("$")
    }

    private suspend fun seed(context: Context, db: TillDatabase, session: SessionStore, restaurant: Boolean, plan: String?) {
        val shop = Json.parseToJsonElement(context.assets.open("demo-shop.json").bufferedReader().use { it.readText() })
        val tenant = shop.str("tenant")!!
        val store = shop.obj("store")
        val device = shop.obj("device")
        val tax = shop.obj("tax")
        val dining = shop.obj("dining")
        val storeId = store.str("id")!!
        db.withTransaction {
            val catalog = db.catalog()
            catalog.upsertStores(listOf(StoreEntity(storeId, tenant, store.str("name")!!, store.str("code")!!)))
            catalog.upsertDevices(listOf(DeviceEntity(device.str("id")!!, tenant, storeId, device.str("name")!!, device.str("code")!!)))
            // a restaurant's settings say nothing about the kind of business, as before there were shops
            val settings = shop.obj("settings")
            val kept = if (restaurant) settings.filterKeys { it != "businessType" } else settings
            db.ops().upsertSettings(SettingsEntity(tenant, JsonObject(if (plan == null) kept else kept + ("plan" to kotlinx.serialization.json.JsonPrimitive(plan))).toString()))
            catalog.upsertTaxes(listOf(TaxEntity(tax.str("id")!!, tenant, tax.str("name")!!, tax.jsonObject["rate_bp"]!!.jsonPrimitive.intOrNull ?: 0, tax.str("type")!!, true)))
            if (restaurant) {
                val r = shop.obj("restaurant")
                catalog.upsertDining(r.arr("dining").mapIndexed { i, d ->
                    DiningOptionEntity(d.str("id")!!, tenant, d.str("name")!!, d.bool("is_default"), i, needs_table = d.bool("needs_table"), kitchen = d.str("kitchen")!!, kind = d.str("kind")!!)
                })
                db.tables().upsertTables(r.arr("tables").mapIndexed { i, t ->
                    com.restopos.core.database.TableEntity(
                        t.str("id")!!, tenant, storeId, t.str("name")!!, t.str("area")!!, t.lng("seats").toInt(), t.str("shape")!!,
                        t.lng("x").toInt(), t.lng("y").toInt(), t.lng("w").toInt(), t.lng("h").toInt(), i,
                    )
                })
            } else {
                catalog.upsertDining(listOf(DiningOptionEntity(dining.str("id")!!, tenant, dining.str("name")!!, true, 0, kitchen = "pay", kind = dining.str("kind")!!)))
            }
            // a shop's Exchange payment type is not a restaurant's
            catalog.upsertPayments(shop.arr("payments").filter { !restaurant || it.str("kind") != "exchange" }.mapIndexed { i, p -> PaymentTypeEntity(p.str("id")!!, tenant, p.str("name")!!, p.str("kind")!!, sort_order = i, opens_drawer = p.bool("opens_drawer")) })
            db.staff().upsertRoles(shop.arr("roles").map { RoleEntity(it.str("id")!!, tenant, it.str("name")!!, it.arr("permissions").toString()) })
            db.staff().upsertEmployees(shop.arr("staff").mapIndexed { i, e -> EmployeeEntity(e.str("id")!!, tenant, e.str("name")!!, pinHash(e.str("pin")!!, ByteArray(16) { b -> (b * 7 + i + 1).toByte() }), e.str("role")) })
            db.staff().upsertEmployeeStores(shop.arr("staff").map { EmployeeStoreEntity(it.str("id")!!, storeId, tenant) })
            catalog.upsertCategories(shop.arr("categories").mapIndexed { i, c -> CategoryEntity(c.str("id")!!, tenant, c.str("name")!!, sort_order = i) })
            val items = shop.arr("items")
            catalog.upsertItems(items.map {
                ItemEntity(
                    it.str("id")!!, tenant, it.str("category"), it.str("name")!!, it.lng("price"), barcode = it.str("barcode"), sku = it.str("sku"),
                    sold_by = it.str("sold_by") ?: "each", track_stock = it.bool("track_stock"), option_names = it.arr("options").toString(),
                )
            })
            catalog.upsertItemTaxes(items.map { ItemTaxCrossRef(it.str("id")!!, tax.str("id")!!) })
            db.retail().upsertVariants(items.flatMap { i ->
                i.arr("variants").map { v -> ItemVariantEntity(v.str("id")!!, tenant, i.str("id")!!, v.str("name")!!, v.lng("price"), v.str("sku"), v.str("barcode"), v.arr("values").toString()) }
            })
            // what the shop holds: a line for each variant, or for the product itself; nothing for what is not counted
            db.retail().upsertLevels(items.filter { it.bool("track_stock") }.flatMap { i ->
                val variants = i.arr("variants")
                if (variants.isEmpty()) listOf(StockLevelEntity(storeId, i.str("id")!!, "", i.lng("stock").toInt()))
                else variants.map { v -> StockLevelEntity(storeId, i.str("id")!!, v.str("id")!!, v.lng("stock").toInt()) }
            })
        }
        session.save(tenant, storeId, device.str("id")!!)
        session.setBusinessName(store.str("name")!!)
    }

    private companion object {
        const val TAG = "DemoShop"
        const val PULL = "com.restopos.app.DEMO_PULL"
        const val SCAN = "com.restopos.app.DEMO_SCAN"
    }
}
