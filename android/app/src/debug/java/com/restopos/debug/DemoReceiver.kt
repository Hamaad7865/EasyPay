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
    }

    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        val deps = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
        CoroutineScope(Dispatchers.IO).launch {
            try {
                if (deps.session().isSetUp()) Log.w(TAG, "refused: this tablet is set up for a business")
                else { seed(context, deps.db(), deps.session()); Log.i(TAG, "seeded: close the app and open it again") }
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

    private suspend fun seed(context: Context, db: TillDatabase, session: SessionStore) {
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
            db.ops().upsertSettings(SettingsEntity(tenant, shop.obj("settings").toString()))
            catalog.upsertTaxes(listOf(TaxEntity(tax.str("id")!!, tenant, tax.str("name")!!, tax.jsonObject["rate_bp"]!!.jsonPrimitive.intOrNull ?: 0, tax.str("type")!!, true)))
            catalog.upsertDining(listOf(DiningOptionEntity(dining.str("id")!!, tenant, dining.str("name")!!, true, 0, kitchen = "pay", kind = dining.str("kind")!!)))
            catalog.upsertPayments(shop.arr("payments").mapIndexed { i, p -> PaymentTypeEntity(p.str("id")!!, tenant, p.str("name")!!, p.str("kind")!!, sort_order = i, opens_drawer = p.bool("opens_drawer")) })
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
    }
}
