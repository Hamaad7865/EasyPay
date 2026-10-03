package com.restopos.core.sync

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.hilt.work.HiltWorker
import androidx.room.withTransaction
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.DeviceEntity
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemModGroupCrossRef
import com.restopos.core.database.ItemTaxCrossRef
import com.restopos.core.database.ModifierEntity
import com.restopos.core.database.ModifierGroupEntity
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.StoreEntity
import com.restopos.core.database.SyncStateEntity
import com.restopos.core.database.TaxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.ApiClient
import com.restopos.core.network.ApiError
import com.restopos.core.network.AuthRequired
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
import java.io.IOException
import java.util.concurrent.TimeUnit

// Pull (spec 5.5): page -> one Room txn incl. next_cursor -> repeat while
// has_more. Triggers: app start, after each push, 15 min, manual, Realtime
// nudge (Phase 6). Realtime never carries trusted data.
@HiltWorker
class PullWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val db: TillDatabase,
    private val api: ApiClient,
    private val session: SessionStore,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        // Nothing to pull until a store is chosen; not a failure.
        val store = session.storeId() ?: return Result.success()
        return try {
            val saved = db.sync().cursor(store)
            var cursor = saved?.cursor ?: 0
            var epochs = saved?.epochs ?: ""
            var pages = 0
            while (pages < MAX_PAGES) {
                pages++
                val page = api.pull(store, cursor)
                val pageEpochs = page.epochs.toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
                if (epochs.isNotEmpty() && pageEpochs.isNotEmpty() && pageEpochs != epochs) {
                    // The server rewrote a table's history: the cursor means
                    // nothing now. Drop the catalog mirror and pull from the start.
                    db.withTransaction {
                        db.catalog().clearCatalog()
                        db.sync().saveCursor(SyncStateEntity(store, 0, pageEpochs))
                    }
                    cursor = 0
                    epochs = pageEpochs
                    continue
                }
                if (pageEpochs.isNotEmpty()) epochs = pageEpochs
                applyPage(store, page.changes, page.nextCursor, epochs)
                cursor = page.nextCursor
                if (!page.hasMore) break
            }
            Result.success()
        } catch (e: AuthRequired) {
            Result.failure() // signed out: retrying cannot help until someone signs in
        } catch (e: IOException) {
            Result.retry() // offline or flaky: WorkManager backs off and tries again
        } catch (e: ApiError) {
            if (e.status >= 500) Result.retry() else Result.failure()
        }
    }

    private suspend fun applyPage(store: String, changes: Map<String, List<JsonElement>>, next: Long, epochs: String) {
        val dao = db.catalog()
        fun id(e: JsonElement) = e.jsonObject["id"]!!.jsonPrimitive.content
        fun str(e: JsonElement, k: String) = e.jsonObject[k]?.jsonPrimitive?.contentOrNull
        fun lng(e: JsonElement, k: String) = e.jsonObject[k]?.jsonPrimitive?.longOrNull
        fun bool(e: JsonElement, k: String, d: Boolean) = e.jsonObject[k]?.jsonPrimitive?.booleanOrNull ?: d
        db.withTransaction {
            changes["categories"]?.let { rows ->
                dao.upsertCategories(rows.map {
                    CategoryEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "color"), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["items"]?.let { rows ->
                dao.upsertItems(rows.map {
                    ItemEntity(id(it), str(it, "tenant_id") ?: "", str(it, "category_id"), str(it, "name") ?: "", lng(it, "price") ?: 0, bool(it, "is_available", true), str(it, "tile_color"), str(it, "image_path"), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["modifier_groups"]?.let { rows ->
                dao.upsertGroups(rows.map {
                    ModifierGroupEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", (lng(it, "min_select") ?: 0).toInt(), (lng(it, "max_select") ?: 1).toInt(), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["modifiers"]?.let { rows ->
                dao.upsertModifiers(rows.map {
                    ModifierEntity(id(it), str(it, "tenant_id") ?: "", str(it, "group_id") ?: "", str(it, "name") ?: "", lng(it, "price") ?: 0, str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["taxes"]?.let { rows ->
                dao.upsertTaxes(rows.map {
                    TaxEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", (lng(it, "rate_bp") ?: 0).toInt(), str(it, "type") ?: "added", bool(it, "is_default", false), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["discounts"]?.let { rows ->
                dao.upsertDiscounts(rows.map {
                    DiscountEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "type") ?: "amount", lng(it, "value") ?: 0, bool(it, "requires_approval", false), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["dining_options"]?.let { rows ->
                dao.upsertDining(rows.map {
                    DiningOptionEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", bool(it, "is_default", false), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["payment_types"]?.let { rows ->
                dao.upsertPayments(rows.map {
                    PaymentTypeEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "kind") ?: "other", bool(it, "is_active", true), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["stores"]?.let { rows ->
                dao.upsertStores(rows.map {
                    StoreEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "code") ?: "", str(it, "timezone") ?: "Indian/Mauritius", str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["pos_devices"]?.let { rows ->
                dao.upsertDevices(rows.map {
                    // The receipt sequence only ever moves forward. This till may
                    // have issued receipts the server has not seen yet; taking the
                    // server's lower number would hand out the same numbers again.
                    val local = dao.device(id(it))?.last_receipt_seq ?: 0
                    DeviceEntity(id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: "", str(it, "name") ?: "", str(it, "code") ?: "", maxOf(local, lng(it, "last_receipt_seq") ?: 0), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["item_taxes"]?.let { rows ->
                dao.upsertItemTaxes(rows.mapNotNull {
                    val item = str(it, "item_id")
                    val tax = str(it, "tax_id")
                    if (item == null || tax == null) null else ItemTaxCrossRef(item, tax)
                })
            }
            changes["item_modifier_groups"]?.let { rows ->
                dao.upsertItemModGroups(rows.mapNotNull {
                    val item = str(it, "item_id")
                    val group = str(it, "group_id")
                    if (item == null || group == null) null else ItemModGroupCrossRef(item, group)
                })
            }
            db.sync().saveCursor(SyncStateEntity(store, next, epochs))
        }
    }

    private companion object {
        const val MAX_PAGES = 50
    }
}

object SyncScheduler {
    private const val PERIODIC = "pull-periodic"
    private const val NOW = "pull-now"
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun pullNow(context: Context) {
        val req = OneTimeWorkRequestBuilder<PullWorker>()
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, req)
    }

    fun startPeriodic(context: Context) {
        val req = PeriodicWorkRequestBuilder<PullWorker>(15, TimeUnit.MINUTES)
            .setConstraints(online)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun stop(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(NOW)
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        WorkManager.getInstance(context).cancelUniqueWork(PUSH_WORK)
    }
}

private val TENANT = stringPreferencesKey("tenant_id")
private val STORE = stringPreferencesKey("store_id")
private val DEVICE = stringPreferencesKey("device_id")
private val ACTIVE_TICKET = stringPreferencesKey("active_ticket")
private val PENDING_DISCOUNT = stringPreferencesKey("pending_discount")
private val Context.sessionPrefs by preferencesDataStore("device")

// Which tenant, store and device this tablet is. Set once at device setup and
// kept across restarts, so the app opens on the menu with or without a network.
class SessionStore(private val context: Context) {
    private val store = context.sessionPrefs

    suspend fun save(tenant: String, storeId: String, device: String) {
        store.edit { it[TENANT] = tenant; it[STORE] = storeId; it[DEVICE] = device }
    }

    suspend fun storeId(): String? = store.data.map { it[STORE] }.first()
    suspend fun deviceId(): String? = store.data.map { it[DEVICE] }.first()
    suspend fun tenantId(): String? = store.data.map { it[TENANT] }.first()
    suspend fun isSetUp(): Boolean = storeId() != null && deviceId() != null
    suspend fun activeTicket(): String? = store.data.map { it[ACTIVE_TICKET] }.first()
    suspend fun setActiveTicket(id: String) { store.edit { it[ACTIVE_TICKET] = id } }
    suspend fun clearActiveTicket() { store.edit { it.remove(ACTIVE_TICKET) } }
    suspend fun pendingDiscount(): String? = store.data.map { it[PENDING_DISCOUNT] }.first()
    suspend fun setPendingDiscount(id: String?) {
        store.edit { if (id == null) it.remove(PENDING_DISCOUNT) else it[PENDING_DISCOUNT] = id }
    }
    suspend fun clear() { store.edit { it.clear() } }
}
