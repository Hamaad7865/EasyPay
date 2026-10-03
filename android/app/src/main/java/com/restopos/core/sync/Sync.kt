package com.restopos.core.sync

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.hilt.work.HiltWorker
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.restopos.core.database.DeviceEntity
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ModifierEntity
import com.restopos.core.database.ModifierGroupEntity
import com.restopos.core.database.StoreEntity
import com.restopos.core.database.TaxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.ApiClient
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import androidx.room.withTransaction
import java.util.concurrent.TimeUnit

// Pull (spec 5.5): page -> one Room txn incl. next_cursor -> repeat while
// has_more. Triggers: app start, after each push (Phase 2), 15 min, manual,
// Realtime nudge (Phase 6). Realtime never carries trusted data.
@HiltWorker
class PullWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val db: TillDatabase,
    private val api: ApiClient,
    private val session: SessionStore,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val store = session.storeId() ?: return Result.failure()
        var cursor = db.sync().cursor(store)?.cursor ?: 0
        repeat(20) {
            val page = api.pull(store, cursor)
            applyPage(page.changes, page.nextCursor)
            cursor = page.nextCursor
            if (!page.hasMore) return Result.success()
        }
        return Result.success()
    }

    private suspend fun applyPage(changes: Map<String, List<kotlinx.serialization.json.JsonElement>>, next: Long) {
        val store = session.storeId() ?: return
        val dao = db.catalog()
        fun str(e: kotlinx.serialization.json.JsonElement, k: String) =
            e.jsonObject[k]?.jsonPrimitive?.contentOrNull
        fun lng(e: kotlinx.serialization.json.JsonElement, k: String) =
            e.jsonObject[k]?.jsonPrimitive?.longOrNull
        fun bool(e: kotlinx.serialization.json.JsonElement, k: String, d: Boolean) =
            e.jsonObject[k]?.jsonPrimitive?.booleanOrNull ?: d
        db.withTransaction {
            changes["categories"]?.let { rows ->
                dao.upsertCategories(rows.map {
                    CategoryEntity(it.jsonObject["id"]!!.jsonPrimitive.content, str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "color"), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["items"]?.let { rows ->
                dao.upsertItems(rows.map {
                    ItemEntity(it.jsonObject["id"]!!.jsonPrimitive.content, str(it, "tenant_id") ?: "", str(it, "category_id"), str(it, "name") ?: "", lng(it, "price") ?: 0, bool(it, "is_available", true), str(it, "tile_color"), str(it, "image_path"), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["modifier_groups"]?.let { rows ->
                dao.upsertGroups(rows.map {
                    ModifierGroupEntity(it.jsonObject["id"]!!.jsonPrimitive.content, str(it, "tenant_id") ?: "", str(it, "name") ?: "", (lng(it, "min_select") ?: 0).toInt(), (lng(it, "max_select") ?: 1).toInt(), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["modifiers"]?.let { rows ->
                dao.upsertModifiers(rows.map {
                    ModifierEntity(it.jsonObject["id"]!!.jsonPrimitive.content, str(it, "tenant_id") ?: "", str(it, "group_id") ?: "", str(it, "name") ?: "", lng(it, "price") ?: 0, str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["taxes"]?.let { rows ->
                dao.upsertTaxes(rows.map {
                    TaxEntity(it.jsonObject["id"]!!.jsonPrimitive.content, str(it, "tenant_id") ?: "", str(it, "name") ?: "", (lng(it, "rate_bp") ?: 0).toInt(), str(it, "type") ?: "added", bool(it, "is_default", false), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["discounts"]?.let { rows ->
                dao.upsertDiscounts(rows.map {
                    com.restopos.core.database.DiscountEntity(it.jsonObject["id"]!!.jsonPrimitive.content, str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "type") ?: "amount", lng(it, "value") ?: 0, bool(it, "requires_approval", false), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["dining_options"]?.let { rows ->
                dao.upsertDining(rows.map {
                    DiningOptionEntity(it.jsonObject["id"]!!.jsonPrimitive.content, str(it, "tenant_id") ?: "", str(it, "name") ?: "", bool(it, "is_default", false), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["payment_types"]?.let { rows ->
                dao.upsertPayments(rows.map {
                    PaymentTypeEntity(it.jsonObject["id"]!!.jsonPrimitive.content, str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "kind") ?: "other", bool(it, "is_active", true), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["stores"]?.let { rows ->
                dao.upsertStores(rows.map {
                    StoreEntity(it.jsonObject["id"]!!.jsonPrimitive.content, str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "code") ?: "", str(it, "timezone") ?: "Indian/Mauritius", str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["pos_devices"]?.let { rows ->
                dao.upsertDevices(rows.map {
                    DeviceEntity(it.jsonObject["id"]!!.jsonPrimitive.content, str(it, "tenant_id") ?: "", str(it, "store_id") ?: "", str(it, "name") ?: "", str(it, "code") ?: "", lng(it, "last_receipt_seq") ?: 0, str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["item_taxes"]?.let { rows ->
                dao.upsertItemTaxes(rows.mapNotNull {
                    val a = it.jsonObject["item_id"]?.jsonPrimitive?.contentOrNull
                    val b = it.jsonObject["tax_id"]?.jsonPrimitive?.contentOrNull
                    if (a == null || b == null) null else com.restopos.core.database.ItemTaxCrossRef(a, b)
                })
            }
            changes["item_modifier_groups"]?.let { rows ->
                dao.upsertItemModGroups(rows.mapNotNull {
                    val a = it.jsonObject["item_id"]?.jsonPrimitive?.contentOrNull
                    val b = it.jsonObject["group_id"]?.jsonPrimitive?.contentOrNull
                    if (a == null || b == null) null else com.restopos.core.database.ItemModGroupCrossRef(a, b)
                })
            }
            db.sync().saveCursor(com.restopos.core.database.SyncStateEntity(store, next))
        }
    }
}

object SyncScheduler {
    private const val PERIODIC = "pull-periodic"
    fun pullNow(context: Context) {
        val req = OneTimeWorkRequestBuilder<PullWorker>()
            .setConstraints(Constraints(requiredNetworkType = NetworkType.CONNECTED))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("pull-now", ExistingWorkPolicy.REPLACE, req)
    }
    fun startPeriodic(context: Context) {
        val req = PeriodicWorkRequestBuilder<PullWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints(requiredNetworkType = NetworkType.CONNECTED))
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }
}

private val TENANT = stringPreferencesKey("tenant_id")
private val STORE = stringPreferencesKey("store_id")
private val DEVICE = stringPreferencesKey("device_id")
private val ACTIVE_TICKET = stringPreferencesKey("active_ticket")
private val PENDING_DISCOUNT = stringPreferencesKey("pending_discount")

class SessionStore constructor(@dagger.hilt.android.qualifiers.ApplicationContext private val context: Context) {
    private val store = context.sessionPrefs
    suspend fun save(tenant: String, storeId: String, device: String) {
        store.edit { it[TENANT] = tenant; it[STORE] = storeId; it[DEVICE] = device }
    }
    suspend fun storeId(): String? = store.data.map { it[STORE] }.first()
    suspend fun deviceId(): String? = store.data.map { it[DEVICE] }.first()
    suspend fun tenantId(): String? = store.data.map { it[TENANT] }.first()
    suspend fun activeTicket(): String? = store.data.map { it[ACTIVE_TICKET] }.first()
    suspend fun setActiveTicket(id: String) { store.edit { it[ACTIVE_TICKET] = id } }
    suspend fun clearActiveTicket() { store.edit { it.remove(ACTIVE_TICKET) } }
    suspend fun pendingDiscount(): String? = store.data.map { it[PENDING_DISCOUNT] }.first()
    suspend fun setPendingDiscount(id: String?) {
        store.edit { if (id == null) it.remove(PENDING_DISCOUNT) else it[PENDING_DISCOUNT] = id }
    }
    suspend fun clear() { store.edit { it.clear() } }
}

private val Context.sessionPrefs by androidx.datastore.preferences.preferencesDataStore("device")
