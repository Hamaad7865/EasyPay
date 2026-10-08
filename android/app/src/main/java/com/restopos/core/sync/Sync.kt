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
import androidx.work.workDataOf
import com.restopos.core.database.CashMoveEntity
import com.restopos.core.database.BookingEntity
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
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.StockLevelEntity
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
// has_more. Triggers: app start, after each push, manual, the first touch
// after the till was left alone, and every 15 minutes while someone is at
// the till or something is waiting to go up (Quiet). Realtime nudge (Phase
// 6). Realtime never carries trusted data.
@HiltWorker
class PullWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val db: TillDatabase,
    private val api: ApiClient,
    private val session: SessionStore,
    private val applier: PullApplier,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        // Nothing to pull until a store is chosen; not a failure.
        val store = session.storeId() ?: return Result.success()
        // The sync every 15 minutes says nothing to the server while no one
        // is at the till and nothing is waiting: the database it would wake
        // is paid for by the hour (Quiet). Nothing below is reached then, the
        // crash reports and the till's key included: they go with the next
        // sync that does.
        val waiting = db.outbox().pendingCount() > 0
        if (!Quiet.syncs(inputData.getBoolean(SyncScheduler.ASKED, false), waiting, System.currentTimeMillis(), session.lastUse())) return Result.success()
        // Anything still waiting to go up goes with every sync: a push that
        // ended on an error is not left until the next sale to try again.
        if (waiting) pushNow(applicationContext)
        // What the till wrote down if it stopped unexpectedly goes up too. A
        // server that does not take it yet, or no network, leaves the files
        // for the next sync; it never holds the sync itself up.
        runCatching {
            val waiting = com.restopos.core.common.Crashes.waiting(applicationContext)
            if (waiting.isNotEmpty()) {
                val device = session.deviceId()
                api.crashes(waiting.map { (_, r) ->
                    if (device == null) r else kotlinx.serialization.json.JsonObject(r + ("device_id" to kotlinx.serialization.json.JsonPrimitive(device)))
                })
                waiting.forEach { (file, _) -> file.delete() }
            }
        }
        // A till set up before tills had keys of their own, or whose key was
        // ended, asks for one while its login is still good. From then on its
        // syncing no longer depends on that login's session. No network, or
        // no session, leaves it for the next sync.
        if (!api.hasTillKey()) session.deviceId()?.let { device -> runCatching { api.fetchTillKey(device) } }
        return try {
            val saved = db.sync().cursor(store)
            var epochs = saved?.epochs ?: ""
            // page after page until the server has no more (PullPaging)
            PullPaging.read(saved?.cursor ?: 0) { cursor ->
                val page = api.pull(store, cursor)
                val pageEpochs = page.epochs.toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
                if (epochs.isNotEmpty() && pageEpochs.isNotEmpty() && pageEpochs != epochs) {
                    // The server rewrote a table's history: the cursor means
                    // nothing now. Drop the catalog mirror and pull from the start.
                    db.withTransaction {
                        db.catalog().clearCatalog()
                        db.retail().clearVariants()
                        db.retail().clearLevels()
                        db.staff().clearStaff()
                        db.tables().clearTables()
                        db.ops().clearPrinters()
                        db.ops().clearSettings()
                        db.customers().clear()
                        db.sync().saveCursor(SyncStateEntity(store, 0, pageEpochs))
                    }
                    epochs = pageEpochs
                    PullPaging.Page(0, more = true, restart = true)
                } else {
                    if (pageEpochs.isNotEmpty()) epochs = pageEpochs
                    applier.apply(store, page.changes, page.nextCursor, epochs)
                    PullPaging.Page(page.nextCursor, page.hasMore)
                }
            }
            session.setLastPull(System.currentTimeMillis())
            // the server took this till: whatever asked for a sign-in before is over
            session.setNeedsSignIn(false)
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
}

object SyncScheduler {
    private const val PERIODIC = "pull-periodic"
    private const val NOW = "pull-now"
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    // Marks a sync that someone or something asked for: it always goes. The
    // one every 15 minutes carries no such mark (nor does the one a tablet
    // has had queued since before this rule), and goes only while the till
    // is in use.
    internal const val ASKED = "asked"

    fun pullNow(context: Context) {
        val req = OneTimeWorkRequestBuilder<PullWorker>()
            .setInputData(workDataOf(ASKED to true))
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
private val SPLIT_SHARES = stringPreferencesKey("split_shares")
private val LEFT_HANDED = booleanPreferencesKey("left_handed")
private val KEEP_AWAKE = booleanPreferencesKey("keep_awake")
private val SCAN_MODE = booleanPreferencesKey("scan_mode")
private val LIGHT = booleanPreferencesKey("light_mode_v2")
private val LAST_PULL = longPreferencesKey("last_pull")
private val LAST_USE = longPreferencesKey("last_use")
private val LANG = stringPreferencesKey("lang")
private val SEQ_DAY = stringPreferencesKey("seq_day")
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
    // The shares of a bill split equally that have been taken and not yet
    // recorded (the receipt goes out when the last guest has paid), with the
    // order they are for. Kept here so that a tablet that dies between two
    // guests still knows what the first ones paid.
    suspend fun splitShares(): String? = store.data.map { it[SPLIT_SHARES] }.first()
    suspend fun setSplitShares(json: String?) { store.edit { if (json == null) it.remove(SPLIT_SHARES) else it[SPLIT_SHARES] = json } }
    // How this tablet is set up for the people using it (Settings, Display).
    val leftHanded: Flow<Boolean> = store.data.map { it[LEFT_HANDED] ?: false }
    suspend fun setLeftHanded(on: Boolean) { store.edit { it[LEFT_HANDED] = on } }
    val keepAwake: Flow<Boolean> = store.data.map { it[KEEP_AWAKE] ?: true }
    suspend fun setKeepAwake(on: Boolean) { store.edit { it[KEEP_AWAKE] = on } }
    // Scan mode, a shop's: the scan key beside the search box is lit, and a
    // scanner's keys are taken below the screen so that no keyboard comes up.
    // Kept on the tablet: a counter that has a scanner sets it once.
    val scanMode: Flow<Boolean> = store.data.map { it[SCAN_MODE] ?: false }
    suspend fun setScanMode(on: Boolean) { store.edit { it[SCAN_MODE] = on } }
    val lightMode: Flow<Boolean> = store.data.map { it[LIGHT] ?: false }
    suspend fun setLightMode(on: Boolean) { store.edit { it[LIGHT] = on } }
    // When this tablet last heard from the server.
    val lastPull: Flow<Long?> = store.data.map { it[LAST_PULL] }
    suspend fun setLastPull(at: Long) { store.edit { it[LAST_PULL] = at } }
    // When someone was last at this till (a touch, a key, a scan), written
    // once a minute at most. The sync every 15 minutes reads it: left alone,
    // a till stops asking the server for news (Quiet).
    suspend fun lastUse(): Long? = store.data.map { it[LAST_USE] }.first()
    suspend fun setLastUse(at: Long) { store.edit { it[LAST_USE] = at } }
    // The language of the till's own words: "en" or "fr".
    val lang: Flow<String> = store.data.map { it[LANG] ?: "en" }
    suspend fun setLang(code: String) { store.edit { it[LANG] = code } }

    // A number that counts up through the day and starts again the next:
    // "C" for counter orders, "A" takeaways, "D" deliveries, "K" kitchen tickets.
    suspend fun nextNumber(series: String): Int {
        val today = java.time.LocalDate.now().toString()
        var out = 1
        store.edit {
            val key = intPreferencesKey("seq_$series")
            if (it[SEQ_DAY] != today) {
                listOf("C", "A", "D", "K").forEach { s -> it.remove(intPreferencesKey("seq_$s")) }
                it[SEQ_DAY] = today
            }
            out = (it[key] ?: 0) + 1
            it[key] = out
        }
        return out
    }

    suspend fun clear() { store.edit { it.clear() } }
}
