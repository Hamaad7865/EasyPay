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
import kotlinx.coroutines.flow.distinctUntilChanged
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
    private val requests: com.restopos.core.data.TillRequests,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        // Nothing to pull until a store is chosen; not a failure.
        val store = session.storeId() ?: return Result.success()
        // A tablet that works on its own says nothing to the server: the
        // database it would wake is the cost the offline plan does not have.
        // Its queue waits. Only what someone asks for on purpose goes through
        // (CONNECT: "Connect to the cloud" and "Get changes from EasyPay"),
        // to learn whether the business has been made Premium and to take
        // what EasyPay set up for it since.
        val connect = inputData.getBoolean(SyncScheduler.CONNECT, false)
        // Not before the first pull has ended: the plan arrives early in it,
        // and a first pull cut short has to be taken up again, or the tablet
        // would be left with half a catalogue for good.
        val filled = session.lastPull.first()?.let { it >= session.registeredAt() } == true
        if (!connect && filled && com.restopos.core.data.PosSettings.parse(db.ops().settings()).alone) return Result.success()
        // The sync every 15 minutes says nothing to the server while no one
        // is at the till and nothing is waiting: the database it would wake
        // is paid for by the hour (Quiet). Nothing below is reached then, the
        // crash reports and the till's key included: they go with the next
        // sync that does.
        val waiting = db.outbox().pendingCount() > 0
        if (!connect && !Quiet.syncs(inputData.getBoolean(SyncScheduler.ASKED, false), waiting, System.currentTimeMillis(), session.lastUse())) return Result.success()
        // Anything still waiting to go up goes with every sync: a push that
        // ended on an error is not left until the next sale to try again.
        // Not while asking whether the business is Premium: the queue is sent
        // only once the answer is yes (below).
        if (waiting && !connect) pushNow(applicationContext)
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
            // the tables this pull brought rows of: what a tablet that asked on purpose says came (Fetched)
            val brought = sortedSetOf<String>()
            // page after page until the server has no more (PullPaging)
            PullPaging.read(saved?.cursor ?: 0) { cursor ->
                val page = api.pull(store, cursor)
                val pageEpochs = page.epochs.toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }
                if (epochs.isNotEmpty() && pageEpochs.isNotEmpty() && pageEpochs != epochs) {
                    // The server rewrote a table's history: the cursor means
                    // nothing now. Drop the catalog mirror and pull from the start.
                    // Not on a tablet that works on its own: what it made
                    // itself is on no server, so emptying it would lose it.
                    // It keeps what it has and is sent everything again,
                    // which lands over its rows of the same things.
                    val onItsOwn = com.restopos.core.data.PosSettings.parse(db.ops().settings()).alone
                    db.withTransaction {
                        if (!onItsOwn) {
                            db.catalog().clearCatalog()
                            db.retail().clearVariants()
                            db.retail().clearLevels()
                            db.staff().clearStaff()
                            db.tables().clearTables()
                            db.tables().clearElements()
                            db.ops().clearPrinters()
                            db.ops().clearSettings()
                            db.customers().clear()
                            // a shop's stock papers as the server sent them; a count or a draft of this tablet's own stays
                            db.stock().clearFromServer()
                        }
                        db.sync().saveCursor(SyncStateEntity(store, 0, pageEpochs))
                    }
                    epochs = pageEpochs
                    PullPaging.Page(0, more = true, restart = true)
                } else {
                    if (pageEpochs.isNotEmpty()) epochs = pageEpochs
                    applier.apply(store, page.changes, page.nextCursor, epochs)
                    page.changes.forEach { (table, rows) -> if (rows.isNotEmpty()) brought.add(table) }
                    PullPaging.Page(page.nextCursor, page.hasMore)
                }
            }
            session.setLastPull(System.currentTimeMillis())
            // Made Premium, or a trial: the business is the cloud's from now on,
            // and /admin clears what it was tried with. A tablet that was setting
            // up is so no more, and what it noted of its sales' stock is the
            // server's to say. Only a plan named so ends it: settings naming
            // none are not an answer.
            if (com.restopos.core.data.PosSettings.parse(db.ops().settings()).cloud && session.settingUp.first()) {
                db.goLive().dropNoted()
                session.setSettingUp(false)
            }
            // Asked whether the business is Premium, and it is: the plan came
            // with the settings just pulled. The queue this tablet kept while
            // it worked on its own goes up now, in the order things happened.
            if (connect && !com.restopos.core.data.PosSettings.parse(db.ops().settings()).alone) {
                pushNow(applicationContext)
                SyncScheduler.startPeriodic(applicationContext)
            }
            // What the back office asked of this till came with the pull (server
            // 0091): close its day, or write down cash taken out. The till does
            // it now, itself. A request that fails is left for the next sync.
            runCatching { requests.run() }
            // the server took this till: whatever asked for a sign-in before is over
            session.setNeedsSignIn(false)
            Result.success(workDataOf(SyncScheduler.BROUGHT to brought.toTypedArray()))
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
    // Marks the one sync a tablet that works on its own makes: "Connect to the cloud".
    internal const val CONNECT = "connect"
    private const val CONNECT_WORK = "connect-now"
    // What a pull that ended well says of itself: the tables it brought rows of.
    const val BROUGHT = "brought"

    // Asks the server once whether the business has been made Premium. It
    // has: the tablet syncs from then on, and what it kept goes up. It has
    // not: the tablet goes on working on its own, with whatever EasyPay set
    // up for the business since it last asked, which comes with the answer
    // ("Get changes from EasyPay" asks the same). Returns the id of the
    // work, to watch it end.
    fun connect(context: Context): java.util.UUID {
        val req = OneTimeWorkRequestBuilder<PullWorker>()
            .setInputData(workDataOf(ASKED to true, CONNECT to true))
            .setConstraints(online)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(CONNECT_WORK, ExistingWorkPolicy.REPLACE, req)
        return req.id
    }

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
        // and the till's MRA work, which does nothing on a till that is not on the MRA
        com.restopos.core.mra.MraWork.start(context)
    }

    fun stop(context: Context) {
        com.restopos.core.mra.MraWork.stop(context)
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
// The order on the left of the menu (Settings, Display). It was "left_handed",
// which put the order on the right when the order was on the left by default;
// the right is the default now, so that key is no longer read.
private val ORDER_LEFT = booleanPreferencesKey("order_left")
private val KEEP_AWAKE = booleanPreferencesKey("keep_awake")
private val SCAN_MODE = booleanPreferencesKey("scan_mode")
private val SCANNERS = stringPreferencesKey("scanners")
private val LABEL_PRINTER = stringPreferencesKey("label_printer")
private val LABEL_TEMPLATE = stringPreferencesKey("label_template")
private val LABEL_TEMPLATES = stringPreferencesKey("label_templates")
private val LIGHT = booleanPreferencesKey("light_mode_v2")
private val LAST_PULL = longPreferencesKey("last_pull")
private val LAST_BACKUP = longPreferencesKey("last_backup")
private val LAST_BACKUP_PLACE = stringPreferencesKey("last_backup_place")
private val LAST_USE = longPreferencesKey("last_use")
private val AUTO_CLOSED = stringPreferencesKey("auto_closed")
private val LANG = stringPreferencesKey("lang")
private val MODE = stringPreferencesKey("mode")
private val CABLE_ON = booleanPreferencesKey("cable_display")
private val CABLE_MESSAGE = stringPreferencesKey("cable_display_message")
private val POLE_ON = booleanPreferencesKey("pole_display")
private val POLE_COMMANDS = stringPreferencesKey("pole_display_commands")
private val POLE_BAUD = intPreferencesKey("pole_display_baud")
private val PAIR_CODE = stringPreferencesKey("pair_code")
private val KITCHEN_EPOCH = stringPreferencesKey("kitchen_epoch")
private val SEQ_DAY = stringPreferencesKey("seq_day")
// the customer number this till gave last (CustomerNumber); a day closing removes it
private val SEQ_CUSTOMER = intPreferencesKey("seq_customer")
// the orders the till rang for before they were due, and their due times (DueReminder.keep)
private val DUE_RUNG = stringPreferencesKey("due_rung")
private val SETUP_CLOSED = booleanPreferencesKey("setup_closed")
private val REGISTERED_AT = longPreferencesKey("registered_at")
// set up before the business sold for real: what is rung up is for trying (core/data/GoLive)
private val SETTING_UP = booleanPreferencesKey("setting_up")
private val Context.sessionPrefs by preferencesDataStore("device")

// Which tenant, store and device this tablet is. Set once at device setup and
// kept across restarts, so the app opens on the menu with or without a network.
class SessionStore(private val context: Context) {
    private val store = context.sessionPrefs

    suspend fun save(tenant: String, storeId: String, device: String) {
        // set up afresh: whatever this tablet knew of a set-up it closed belongs to the business it was for
        store.edit { it[TENANT] = tenant; it[STORE] = storeId; it[DEVICE] = device; it.remove(SETUP_CLOSED); it.remove(SETTING_UP) }
    }

    // ---- setting up, then Go live (an offline tablet's: core/data/GoLive) ----
    // The business was not selling yet when this tablet was set up with its
    // code: what is rung up on it is for trying, and goes at Go live. Kept
    // here, so a backup carries it. It counts only while the tablet works on
    // its own (tryingOut).
    val settingUp: Flow<Boolean> = store.data.map { it[SETTING_UP] ?: false }
    suspend fun setSettingUp(on: Boolean) { store.edit { if (on) it[SETTING_UP] = true else it.remove(SETTING_UP) } }

    // Go live, the tablet's own side, written after the database: the day's
    // bill numbers, the customer and kitchen numbers, the order on the
    // screen and what waited to go on one, the reminders rung, all of them
    // the sales' that went, start again; and the tablet is setting up no
    // more. One write, so it is all or nothing.
    suspend fun wentLive() {
        store.edit {
            listOf(ACTIVE_TICKET, PENDING_DISCOUNT, PENDING_TABLE, PENDING_DINING, SPLIT_SHARES, SEQ_DAY, DUE_RUNG).forEach { k -> it.remove(k) }
            listOf(PENDING_COVERS, PAY_CHECK, SEQ_CUSTOMER).forEach { k -> it.remove(k) }
            listOf("C", "A", "D", "K").forEach { s -> it.remove(intPreferencesKey("seq_$s")) }
            it[PERIOD_SEQ] = 0
            it.remove(SETTING_UP)
        }
    }

    // ---- the first-run set-up (server 0089) ----
    // When this tablet was named as a till. A tablet just registered holds
    // nothing of its business until a pull has finished after this moment
    // (lastPull); what it does next waits for that (SetupSteps.after).
    suspend fun registeredAt(): Long = store.data.map { it[REGISTERED_AT] ?: 0L }.first()
    suspend fun setRegisteredAt(at: Long) { store.edit { it[REGISTERED_AT] = at } }
    // "Open the till" was tapped here. The server is told too, but that is
    // queued like a sale: this hides the start screen's key at once.
    val setupClosed: Flow<Boolean> = store.data.map { it[SETUP_CLOSED] ?: false }
    suspend fun setSetupClosed(closed: Boolean) { store.edit { it[SETUP_CLOSED] = closed } }

    suspend fun storeId(): String? = store.data.map { it[STORE] }.first()
    suspend fun deviceId(): String? = store.data.map { it[DEVICE] }.first()
    suspend fun tenantId(): String? = store.data.map { it[TENANT] }.first()
    suspend fun isSetUp(): Boolean = storeId() != null && deviceId() != null

    // ---- a tablet set up as a kitchen screen, not as a till (core/kitchen) ----
    // It belongs to no business and has no login: it shows what the tills of
    // the restaurant send it over the Wi-Fi. What it keeps here: that it is
    // one, the pairing code it shows (typed into the back office, under
    // Printers), and an id made at each set-up, by which a till knows a
    // tablet that was set up afresh and holds nothing it was sent before.
    suspend fun isKitchen(): Boolean = store.data.map { it[MODE] == "kitchen" }.first()
    suspend fun setKitchen(code: String) {
        store.edit {
            it[MODE] = "kitchen"
            if (it[PAIR_CODE] == null) it[PAIR_CODE] = code
            it[KITCHEN_EPOCH] = java.util.UUID.randomUUID().toString()
        }
    }
    val pairCode: Flow<String?> = store.data.map { it[PAIR_CODE] }
    suspend fun pairCode(): String = pairCode.first().orEmpty()
    suspend fun setPairCode(code: String) { store.edit { it[PAIR_CODE] = code } }
    suspend fun kitchenEpoch(): String = store.data.map { it[KITCHEN_EPOCH] }.first().orEmpty()
    suspend fun leaveKitchen() { store.edit { it.remove(MODE); it.remove(PAIR_CODE); it.remove(KITCHEN_EPOCH) } }

    // ---- a tablet set up as a customer display (core/display) ----
    // It faces the customer and shows the sale of the till it is paired
    // with: no business, no login. It keeps that it is one and its pairing
    // code (the kitchen screen's key: a tablet is one or the other). It
    // starts light, the way a shop counter is; the switch is on the display.
    suspend fun isDisplay(): Boolean = store.data.map { it[MODE] == "display" }.first()
    suspend fun setDisplay(code: String) {
        store.edit {
            it[MODE] = "display"
            if (it[PAIR_CODE] == null) it[PAIR_CODE] = code
            if (it[LIGHT] == null) it[LIGHT] = true
        }
    }
    suspend fun leaveDisplay() { store.edit { it.remove(MODE); it.remove(PAIR_CODE) } }

    // ---- the customer display on a second screen joined to this till by a cable ----
    // A tablet setting, as the label printer is: the screen belongs to the
    // tablet it is plugged into. Off until switched on; its two lines for
    // between sales beside it.
    val cableDisplay: Flow<Boolean> = store.data.map { it[CABLE_ON] ?: false }.distinctUntilChanged()
    val cableMessage: Flow<String> = store.data.map { it[CABLE_MESSAGE].orEmpty() }.distinctUntilChanged()
    suspend fun setCableDisplay(on: Boolean, message: String) { store.edit { it[CABLE_ON] = on; it[CABLE_MESSAGE] = message } }

    // ---- a 2-line customer pole display plugged into this tablet by USB (core/display/PoleDisplay) ----
    // A tablet setting too: whether it is used, which kind of command it
    // takes (PoleText.EPSON or CD5220) and its speed.
    data class Pole(val on: Boolean = false, val commands: String = "epson", val baud: Int = 9600)
    val pole: Flow<Pole> = store.data.map { Pole(it[POLE_ON] ?: false, it[POLE_COMMANDS] ?: "epson", it[POLE_BAUD] ?: 9600) }.distinctUntilChanged()
    suspend fun setPole(p: Pole) { store.edit { it[POLE_ON] = p.on; it[POLE_COMMANDS] = p.commands; it[POLE_BAUD] = p.baud } }
    suspend fun businessName(): String? = store.data.map { it[BUSINESS] }.first()
    suspend fun setBusinessName(name: String) { store.edit { it[BUSINESS] = name } }

    // Set by the sync workers when the session has expired, cleared by a
    // successful sign-in. While it is set the tablet keeps selling and keeps
    // every sale in the outbox.
    val needsSignIn: Flow<Boolean> = store.data.map { it[NEEDS_SIGN_IN] ?: false }
    suspend fun setNeedsSignIn(value: Boolean) { store.edit { it[NEEDS_SIGN_IN] = value } }
    suspend fun activeTicket(): String? = store.data.map { it[ACTIVE_TICKET] }.first()
    // the order on the register, as it changes (the customer display follows it)
    val activeTicketFlow: Flow<String?> = store.data.map { it[ACTIVE_TICKET] }.distinctUntilChanged()
    val pendingDiscountFlow: Flow<String?> = store.data.map { it[PENDING_DISCOUNT] }.distinctUntilChanged()
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
    val orderLeft: Flow<Boolean> = store.data.map { it[ORDER_LEFT] ?: false }
    suspend fun setOrderLeft(on: Boolean) { store.edit { it[ORDER_LEFT] = on } }
    val keepAwake: Flow<Boolean> = store.data.map { it[KEEP_AWAKE] ?: true }
    suspend fun setKeepAwake(on: Boolean) { store.edit { it[KEEP_AWAKE] = on } }
    // Scan mode, a shop's: the scan key beside the search box is lit, and a
    // scanner's keys are taken below the screen so that no keyboard comes up.
    // Kept on the tablet: a counter that has a scanner sets it once.
    val scanMode: Flow<Boolean> = store.data.map { it[SCAN_MODE] ?: false }
    suspend fun setScanMode(on: Boolean) { store.edit { it[SCAN_MODE] = on } }
    // The scanners added on this tablet (Settings, Scanners). They belong to
    // the tablet they are plugged into or paired with, not to the business:
    // kept here, never sent anywhere.
    val scanners: Flow<List<com.restopos.core.common.AddedScanner>> = store.data.map { com.restopos.core.common.AddedScanners.read(it[SCANNERS]) }
    suspend fun addScanner(one: com.restopos.core.common.AddedScanner) {
        store.edit { it[SCANNERS] = com.restopos.core.common.AddedScanners.write(com.restopos.core.common.AddedScanners.with(com.restopos.core.common.AddedScanners.read(it[SCANNERS]), one)) }
    }
    suspend fun removeScanner(key: String) {
        store.edit { it[SCANNERS] = com.restopos.core.common.AddedScanners.write(com.restopos.core.common.AddedScanners.without(com.restopos.core.common.AddedScanners.read(it[SCANNERS]), key)) }
    }
    // The printer this tablet's labels come out of (a shop's: More, Label
    // printer), and the ready-made label last picked. The tablet's own, like
    // the scanners: the printer is the one plugged into it or paired with it.
    val labelPrinter: Flow<com.restopos.core.print.LabelPrinter?> = store.data.map { com.restopos.core.print.LabelPrinters.read(it[LABEL_PRINTER]) }
    suspend fun setLabelPrinter(p: com.restopos.core.print.LabelPrinter?) {
        store.edit { if (p == null) it.remove(LABEL_PRINTER) else it[LABEL_PRINTER] = com.restopos.core.print.LabelPrinters.write(p) }
    }
    val labelTemplate: Flow<String?> = store.data.map { it[LABEL_TEMPLATE] }
    suspend fun setLabelTemplate(id: String) { store.edit { it[LABEL_TEMPLATE] = id } }
    // The labels this shop designed itself (LabelBook). They are kept here and
    // nowhere else: another tablet of the shop does not have them.
    val labelTemplates: Flow<List<com.restopos.core.print.LabelTemplate>> = store.data.map { com.restopos.core.print.LabelBook.read(it[LABEL_TEMPLATES]) }
    suspend fun saveLabelTemplate(t: com.restopos.core.print.LabelTemplate) {
        store.edit { it[LABEL_TEMPLATES] = com.restopos.core.print.LabelBook.write(com.restopos.core.print.LabelBook.with(com.restopos.core.print.LabelBook.read(it[LABEL_TEMPLATES]), t)) }
    }
    suspend fun removeLabelTemplate(id: String) {
        store.edit { it[LABEL_TEMPLATES] = com.restopos.core.print.LabelBook.write(com.restopos.core.print.LabelBook.without(com.restopos.core.print.LabelBook.read(it[LABEL_TEMPLATES]), id)) }
    }
    val lightMode: Flow<Boolean> = store.data.map { it[LIGHT] ?: false }
    suspend fun setLightMode(on: Boolean) { store.edit { it[LIGHT] = on } }
    // When this tablet last heard from the server.
    val lastPull: Flow<Long?> = store.data.map { it[LAST_PULL] }
    suspend fun setLastPull(at: Long) { store.edit { it[LAST_PULL] = at } }
    // when this tablet's backup was last saved to a file (core/data/Backup)
    val lastBackup: Flow<Long?> = store.data.map { it[LAST_BACKUP] }
    suspend fun setLastBackup(at: Long) { store.edit { it[LAST_BACKUP] = at; it.remove(LAST_BACKUP_PLACE) } }
    // Where the till put it, when it was the till that chose: a tablet with
    // no screen to choose a place on (Backup.saveOnTablet). Null when the
    // owner chose the place.
    val lastBackupPlace: Flow<String?> = store.data.map { it[LAST_BACKUP_PLACE] }
    suspend fun setLastBackupPlace(place: String) { store.edit { it[LAST_BACKUP_PLACE] = place } }
    // When someone was last at this till (a touch, a key, a scan), written
    // once a minute at most. The sync every 15 minutes reads it: left alone,
    // a till stops asking the server for news (Quiet).
    suspend fun lastUse(): Long? = store.data.map { it[LAST_USE] }.first()
    suspend fun setLastUse(at: Long) { store.edit { it[LAST_USE] = at } }
    // What the till did when it closed a day by itself (AutoClose), kept
    // until the next person in has been told: a restart does not lose it.
    suspend fun autoClosed(): String? = store.data.map { it[AUTO_CLOSED] }.first()
    suspend fun setAutoClosed(text: String?) { store.edit { if (text == null) it.remove(AUTO_CLOSED) else it[AUTO_CLOSED] = text } }
    // The language of the till's own words: "en" or "fr".
    val lang: Flow<String> = store.data.map { it[LANG] ?: "en" }
    suspend fun setLang(code: String) { store.edit { it[LANG] = code } }

    // A number that counts up through the day and starts again the next: "K"
    // for kitchen tickets. (C, A and D counted the orders until the customer
    // number, nextCustomer.)
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

    // The customer number this till gives next (CustomerNumber): one count
    // for every order without a table, from 1, started again only by a day
    // closing (dayClosed), not at midnight. The owner: "closing the register
    // resets this number".
    suspend fun nextCustomer(): Int {
        var out = 1
        store.edit {
            out = (it[SEQ_CUSTOMER] ?: 0) + 1
            it[SEQ_CUSTOMER] = out
        }
        return out
    }

    // This till's day is closed: the bills since the closing, and the
    // customer numbers, start again.
    suspend fun dayClosed() {
        store.edit {
            it[PERIOD_SEQ] = 0
            it.remove(SEQ_CUSTOMER)
        }
    }

    // What the till rang for before it was due (DueReminders), kept so a
    // restart does not ring again.
    suspend fun dueRung(): String? = store.data.map { it[DUE_RUNG] }.first()
    suspend fun setDueRung(text: String) { store.edit { it[DUE_RUNG] = text } }

    // Everything the tablet holds for the business it was set up for. What
    // belongs to the tablet itself stays: the scanners added on it, and its
    // label printer with the label last picked. The labels designed on it
    // stay too: there is no other copy of them, and a sign-out that lost a
    // shop its designs would cost more than a tablet that changes hands with
    // them still on it.
    suspend fun clear() {
        store.edit {
            // (a key `to` a value is DataStore's own pair here, hence Pair)
            val kept = listOf(SCANNERS, LABEL_PRINTER, LABEL_TEMPLATE, LABEL_TEMPLATES).mapNotNull { key -> it[key]?.let { v -> Pair(key, v) } }
            it.clear()
            kept.forEach { (key, v) -> it[key] = v }
        }
    }
}
