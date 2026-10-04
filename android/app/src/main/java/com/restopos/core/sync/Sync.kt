package com.restopos.core.sync

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
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
import com.restopos.core.database.CashMoveEntity
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.CustomerEntity
import com.restopos.core.database.DayCloseEntity
import com.restopos.core.database.DeviceEntity
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.DrawerCountEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.EmployeeStoreEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemModGroupCrossRef
import com.restopos.core.database.ItemTaxCrossRef
import com.restopos.core.database.ModifierEntity
import com.restopos.core.database.ModifierGroupEntity
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.PunchEntity
import com.restopos.core.database.RoleEntity
import com.restopos.core.database.SettingsEntity
import com.restopos.core.database.ShiftEntity
import com.restopos.core.database.StoreEntity
import com.restopos.core.database.SyncStateEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TaxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.ApiClient
import com.restopos.core.network.ApiError
import com.restopos.core.network.AuthRequired
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.IOException
import java.time.OffsetDateTime
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
                        db.staff().clearStaff()
                        db.tables().clearTables()
                        db.ops().clearPrinters()
                        db.ops().clearSettings()
                        db.customers().clear()
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
            session.setLastPull(System.currentTimeMillis())
            Result.success()
        } catch (e: AuthRequired) {
            // The session is gone. Nothing is lost: the tablet shows a sign-in
            // prompt, and signing in again resumes syncing.
            session.setNeedsSignIn(true)
            Result.failure()
        } catch (e: IOException) {
            Result.retry() // offline or flaky: WorkManager backs off and tries again
        } catch (e: ApiError) {
            // 403 on a sync call means this login is no longer linked to the
            // restaurant (switched off). Same remedy as a lost session.
            if (e.status == 403) session.setNeedsSignIn(true)
            if (e.status >= 500) Result.retry() else Result.failure()
        }
    }

    private suspend fun applyPage(store: String, changes: Map<String, List<JsonElement>>, next: Long, epochs: String) {
        val dao = db.catalog()
        fun id(e: JsonElement) = e.jsonObject["id"]!!.jsonPrimitive.content
        fun str(e: JsonElement, k: String) = e.jsonObject[k]?.jsonPrimitive?.contentOrNull
        fun lng(e: JsonElement, k: String) = e.jsonObject[k]?.jsonPrimitive?.longOrNull
        fun bool(e: JsonElement, k: String, d: Boolean) = e.jsonObject[k]?.jsonPrimitive?.booleanOrNull ?: d
        // a server timestamp ("2026-10-04T08:27:15.278+00:00") as epoch millis
        fun time(e: JsonElement, k: String): Long? =
            str(e, k)?.let { runCatching { OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() }
        db.withTransaction {
            changes["categories"]?.let { rows ->
                dao.upsertCategories(rows.map {
                    CategoryEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "color"), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                        printer_ids = it.jsonObject["printer_ids"]?.takeIf { v -> v is kotlinx.serialization.json.JsonArray }?.toString() ?: "[]",
                        is_stock = bool(it, "is_stock", false),
                    )
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
                    DiningOptionEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", bool(it, "is_default", false), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                        needs_table = bool(it, "needs_table", false), kitchen = str(it, "kitchen") ?: "save",
                    )
                })
            }
            changes["payment_types"]?.let { rows ->
                dao.upsertPayments(rows.map {
                    PaymentTypeEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "kind") ?: "other", bool(it, "is_active", true), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                        opens_drawer = bool(it, "opens_drawer", false),
                    )
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
            val ops = db.ops()
            // a link taken off in the back office (an item's tax changed, an
            // add-on group unticked) is taken off here too
            changes["item_taxes"]?.let { rows ->
                rows.forEach {
                    val item = str(it, "item_id")
                    val tax = str(it, "tax_id")
                    if (item != null && tax != null && str(it, "deleted_at") != null) ops.unlinkTax(item, tax)
                }
                dao.upsertItemTaxes(rows.mapNotNull {
                    val item = str(it, "item_id")
                    val tax = str(it, "tax_id")
                    if (item == null || tax == null || str(it, "deleted_at") != null) null else ItemTaxCrossRef(item, tax)
                })
            }
            changes["item_modifier_groups"]?.let { rows ->
                rows.forEach {
                    val item = str(it, "item_id")
                    val group = str(it, "group_id")
                    if (item != null && group != null && str(it, "deleted_at") != null) ops.unlinkGroup(item, group)
                }
                dao.upsertItemModGroups(rows.mapNotNull {
                    val item = str(it, "item_id")
                    val group = str(it, "group_id")
                    if (item == null || group == null || str(it, "deleted_at") != null) null else ItemModGroupCrossRef(item, group)
                })
            }
            changes["printers"]?.let { rows ->
                ops.upsertPrinters(rows.map {
                    PrinterEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "name") ?: "", str(it, "kind") ?: "network", str(it, "address"),
                        (lng(it, "paper_mm") ?: 80).toInt(), bool(it, "is_receipt", false), (lng(it, "feed_lines") ?: 3).toInt(), bool(it, "cut", true),
                        bool(it, "is_active", true), (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
            }
            changes["pos_settings"]?.lastOrNull()?.let {
                val data = it.jsonObject["data"]?.toString() ?: "{}"
                ops.upsertSettings(SettingsEntity(str(it, "tenant_id") ?: "", data))
                com.restopos.core.common.Money.decimals = com.restopos.core.data.PosSettings.parse(data).decimals
            }
            // Cash movements and day closings are made on this till. The copies
            // that come back only matter after a reinstall; one made here and
            // not sent yet is never touched by the pull.
            changes["cash_movements"]?.let { rows ->
                ops.upsertCashMoves(rows.mapNotNull {
                    val at = time(it, "device_time") ?: time(it, "created_at") ?: return@mapNotNull null
                    CashMoveEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "", str(it, "shift_id"), str(it, "employee_id"),
                        str(it, "type") ?: "out", lng(it, "amount") ?: 0, str(it, "reason"), at, str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
            }
            changes["customers"]?.let { rows ->
                db.customers().upsert(rows.map {
                    CustomerEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "phone"), str(it, "email"), str(it, "note"), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["drawer_counts"]?.let { rows ->
                ops.upsertDrawerCounts(rows.mapNotNull {
                    val at = time(it, "device_time") ?: time(it, "created_at") ?: return@mapNotNull null
                    DrawerCountEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "", str(it, "shift_id") ?: return@mapNotNull null,
                        str(it, "employee_id"), lng(it, "counted") ?: 0, lng(it, "expected") ?: 0, at, str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
            }
            changes["day_closes"]?.let { rows ->
                ops.upsertDayCloses(rows.mapNotNull {
                    val at = time(it, "closed_at") ?: return@mapNotNull null
                    DayCloseEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "", (lng(it, "number") ?: 0).toInt(),
                        str(it, "closed_by"), time(it, "from_time"), at, str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
            }
            changes["tables"]?.let { rows ->
                db.tables().upsertTables(rows.map {
                    TableEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "name") ?: "", str(it, "area") ?: "Main",
                        (lng(it, "seats") ?: 4).toInt(), str(it, "shape") ?: "square",
                        (lng(it, "x") ?: 0).toInt(), (lng(it, "y") ?: 0).toInt(), (lng(it, "w") ?: 10).toInt(), (lng(it, "h") ?: 10).toInt(),
                        (lng(it, "sort_order") ?: 0).toInt(), str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                })
            }
            val staff = db.staff()
            changes["roles"]?.let { rows ->
                staff.upsertRoles(rows.map {
                    RoleEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", it.jsonObject["permissions"]?.toString() ?: "[]", str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["employees"]?.let { rows ->
                staff.upsertEmployees(rows.map {
                    EmployeeEntity(id(it), str(it, "tenant_id") ?: "", str(it, "name") ?: "", str(it, "pin_hash"), str(it, "role_id"), bool(it, "is_active", true), str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["employee_stores"]?.let { rows ->
                staff.upsertEmployeeStores(rows.mapNotNull {
                    val employee = str(it, "employee_id")
                    val at = str(it, "store_id")
                    if (employee == null || at == null) null
                    else EmployeeStoreEntity(employee, at, str(it, "tenant_id") ?: "", str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["timeclock_punches"]?.let { rows ->
                staff.upsertPunches(rows.mapNotNull {
                    val employee = str(it, "employee_id")
                    val at = time(it, "device_time")
                    if (employee == null || at == null) null
                    else PunchEntity(id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id"), employee, str(it, "kind") ?: "in", at, str(it, "deleted_at"), lng(it, "server_seq"))
                })
            }
            changes["shifts"]?.let { rows ->
                staff.upsertShifts(rows.mapNotNull {
                    val opened = time(it, "opened_at") ?: return@mapNotNull null
                    val pulled = ShiftEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "",
                        str(it, "opened_by"), opened, lng(it, "opening_float") ?: 0, str(it, "closed_by"), time(it, "closed_at"),
                        lng(it, "expected_cash"), lng(it, "counted_cash"), str(it, "deleted_at"), lng(it, "server_seq"),
                    )
                    // A period closed on this tablet stays closed. Until the
                    // close has been sent, the server still has it open, and
                    // taking its copy would reopen it here.
                    val local = staff.shift(pulled.id)
                    if (local?.closed_at != null && pulled.closed_at == null) null else pulled
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
private val NEEDS_SIGN_IN = booleanPreferencesKey("needs_sign_in")
private val BUSINESS = stringPreferencesKey("business_name")
private val PENDING_TABLE = stringPreferencesKey("pending_table")
private val PENDING_COVERS = intPreferencesKey("pending_covers")
private val PENDING_DINING = stringPreferencesKey("pending_dining")
private val PERIOD_SEQ = intPreferencesKey("period_seq")
private val PAY_CHECK = intPreferencesKey("pay_check")
private val LEFT_HANDED = booleanPreferencesKey("left_handed")
private val KEEP_AWAKE = booleanPreferencesKey("keep_awake")
private val LIGHT = booleanPreferencesKey("light_mode")
private val LAST_PULL = longPreferencesKey("last_pull")
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
    suspend fun businessName(): String? = store.data.map { it[BUSINESS] }.first()
    suspend fun setBusinessName(name: String) { store.edit { it[BUSINESS] = name } }

    // Set by the sync workers when the session has expired, cleared by a
    // successful sign-in. While it is set the tablet keeps selling and keeps
    // every sale in the outbox.
    val needsSignIn: Flow<Boolean> = store.data.map { it[NEEDS_SIGN_IN] ?: false }
    suspend fun setNeedsSignIn(value: Boolean) { store.edit { it[NEEDS_SIGN_IN] = value } }
    suspend fun activeTicket(): String? = store.data.map { it[ACTIVE_TICKET] }.first()
    suspend fun setActiveTicket(id: String) { store.edit { it[ACTIVE_TICKET] = id } }
    suspend fun clearActiveTicket() { store.edit { it.remove(ACTIVE_TICKET) } }
    // The table a new order will be on: picked on the floor plan, used when
    // the first item creates the order.
    suspend fun pendingTable(): String? = store.data.map { it[PENDING_TABLE] }.first()
    // and how many guests sat down at it; cleared with the table
    suspend fun pendingCovers(): Int? = store.data.map { it[PENDING_COVERS] }.first()
    suspend fun setPendingTable(id: String?, covers: Int? = null) {
        store.edit {
            if (id == null) it.remove(PENDING_TABLE) else it[PENDING_TABLE] = id
            if (id == null || covers == null) it.remove(PENDING_COVERS) else it[PENDING_COVERS] = covers
        }
    }
    suspend fun pendingDiscount(): String? = store.data.map { it[PENDING_DISCOUNT] }.first()
    suspend fun setPendingDiscount(id: String?) {
        store.edit { if (id == null) it.remove(PENDING_DISCOUNT) else it[PENDING_DISCOUNT] = id }
    }
    // The order type picked when the order was started (Dine in, Take away);
    // used when the first item creates the order.
    suspend fun pendingDining(): String? = store.data.map { it[PENDING_DINING] }.first()
    suspend fun setPendingDining(id: String?) {
        store.edit { if (id == null) it.remove(PENDING_DINING) else it[PENDING_DINING] = id }
    }
    // Bills issued since the last day closing, for "start again each day".
    suspend fun periodSeq(): Int = store.data.map { it[PERIOD_SEQ] ?: 0 }.first()
    suspend fun setPeriodSeq(n: Int) { store.edit { it[PERIOD_SEQ] = n } }
    // The check of a split check the payment screen is about to open on; read
    // once by the payment screen and cleared.
    suspend fun payCheck(): Int? = store.data.map { it[PAY_CHECK] }.first()
    suspend fun setPayCheck(n: Int?) { store.edit { if (n == null) it.remove(PAY_CHECK) else it[PAY_CHECK] = n } }
    // How this tablet is set up for the people using it (Settings, Display).
    val leftHanded: Flow<Boolean> = store.data.map { it[LEFT_HANDED] ?: false }
    suspend fun setLeftHanded(on: Boolean) { store.edit { it[LEFT_HANDED] = on } }
    val keepAwake: Flow<Boolean> = store.data.map { it[KEEP_AWAKE] ?: true }
    suspend fun setKeepAwake(on: Boolean) { store.edit { it[KEEP_AWAKE] = on } }
    val lightMode: Flow<Boolean> = store.data.map { it[LIGHT] ?: false }
    suspend fun setLightMode(on: Boolean) { store.edit { it[LIGHT] = on } }
    // When this tablet last heard from the server.
    val lastPull: Flow<Long?> = store.data.map { it[LAST_PULL] }
    suspend fun setLastPull(at: Long) { store.edit { it[LAST_PULL] = at } }
    suspend fun clear() { store.edit { it.clear() } }
}
