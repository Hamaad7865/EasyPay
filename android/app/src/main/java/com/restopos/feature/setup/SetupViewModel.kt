package com.restopos.feature.setup

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.PinHash
import com.restopos.core.common.Uuid7
import com.restopos.core.data.Approvals
import com.restopos.core.data.CategoryForm
import com.restopos.core.data.CompanyForm
import com.restopos.core.data.ItemForm
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.PosSettings
import com.restopos.core.data.PrinterForm
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.SetupDoor
import com.restopos.core.data.SetupFacts
import com.restopos.core.data.SetupStep
import com.restopos.core.data.SetupSteps
import com.restopos.core.data.StaffForm
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffRepository
import com.restopos.core.data.StaffSession
import com.restopos.core.data.TableLayout
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.RoleEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.Docs
import com.restopos.core.print.EscPos
import com.restopos.core.print.Paper
import com.restopos.core.print.Printing
import com.restopos.core.sync.SessionStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

// One line of the Tables step: a room being typed. Its key stays with it, so
// that the tables it was given ids for are sent with the same ids again.
data class RoomLine(val key: String, val name: String = "", val count: String = "", val seats: String = "")

// The first-run set-up: what a new business is walked through on its tablet
// (its menu, tables, printer, details and staff PINs), and the summary it ends
// on. The same screens open again later from the start screen and from
// Settings.
//
// What it shows is what the tablet's own database holds, so a step is done
// whoever did it. What it saves is asked of the server and waited for
// (ServiceRepository); the row then comes with a pull that is started and not
// waited for. Until that pull lands, what was just saved is shown from here:
// laid over what the database holds, and let go of once the database has it.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class SetupViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    val service: ServiceRepository,
    staffRepo: StaffRepository,
    private val staff: StaffSession,
    val approvals: Approvals,
    private val printing: Printing,
    door: SetupDoor,
) : ViewModel() {
    // Who approved the set-up being opened from Settings, when the person
    // signed in could not open it alone. Nobody on a first run, and nobody
    // from the start screen, where whoever entered their PIN is signed in.
    private val approver: StaffMember? = door.approver

    private fun <T> Flow<T>.held(first: T): StateFlow<T> = stateIn(viewModelScope, SharingStarted.Eagerly, first)
    private val json = Json { ignoreUnknownKeys = true }
    private fun perms(text: String?): Set<String> =
        runCatching { json.parseToJsonElement(text ?: "[]").jsonArray.map { it.jsonPrimitive.content }.toSet() }.getOrDefault(emptySet())

    private var tenant = ""
    private var storeId = ""
    private val store: Flow<String> = flow {
        tenant = session.tenantId().orEmpty()
        session.storeId()?.let { storeId = it; emit(it) }
    }

    // ---- the business ----
    private val settingsNow: Flow<PosSettings> = db.ops().settingsFlow().map { PosSettings.parse(it) }
    val settings: StateFlow<PosSettings> = settingsNow.held(PosSettings())
    val retail: Boolean get() = settings.value.retail
    // the set-up is still open for this business, and this tablet has not closed it
    val open: StateFlow<Boolean> = combine(settingsNow, session.setupClosed) { s, closed -> s.setupOpen && !closed }.held(false)

    // its details: what was saved here on this visit, else what the settings hold
    private val savedCompany = MutableStateFlow<CompanyForm.Company?>(null)
    private val companyNow: Flow<CompanyForm.Company> = combine(settingsNow, savedCompany) { s, mine ->
        mine ?: CompanyForm.Company(s.companyName.ifBlank { session.businessName().orEmpty() }, s.address, s.phone, s.brn, s.vat)
    }
    val company: StateFlow<CompanyForm.Company?> = companyNow.map<CompanyForm.Company, CompanyForm.Company?> { it }.held(null)

    // ---- the menu ----
    private val newCats = MutableStateFlow<List<CategoryEntity>>(emptyList())
    private val catsNow: Flow<List<CategoryEntity>> = combine(db.catalog().categories(), newCats) { stored, mine ->
        stored + mine.filterNot { m -> stored.any { it.id == m.id } }
    }
    val categories: StateFlow<List<CategoryEntity>> = catsNow.held(emptyList())
    // the category whose items are on show
    val category = MutableStateFlow<String?>(null)

    private val newItems = MutableStateFlow<List<ItemEntity>>(emptyList())
    // the items made here that no pull has brought yet
    private val waiting: Flow<List<ItemEntity>> = newItems.flatMapLatest { mine ->
        if (mine.isEmpty()) flowOf(emptyList()) else db.service().itemsHeld(mine.map { it.id }).map { held -> mine.filterNot { it.id in held } }
    }
    val items: StateFlow<List<ItemEntity>> = category.flatMapLatest { c ->
        if (c == null) flowOf(emptyList())
        else combine(db.service().items(c, ""), waiting) { stored, mine -> stored + mine.filter { it.category_id == c && stored.none { s -> s.id == it.id } } }
    }.held(emptyList())
    val counts: StateFlow<Map<String, Int>> = combine(db.catalog().itemsPerCategory(), waiting) { rows, mine ->
        rows.associate { it.id to it.n }.toMutableMap().also { m -> mine.forEach { i -> i.category_id?.let { c -> m[c] = (m[c] ?: 0) + 1 } } }
    }.held(emptyMap())

    // ---- the tables ----
    private val newTables = MutableStateFlow<List<TableEntity>>(emptyList())
    private val tablesNow: Flow<List<TableEntity>> = combine(store.flatMapLatest { db.tables().tables(it) }, newTables) { stored, mine ->
        stored + mine.filterNot { m -> stored.any { it.id == m.id } }
    }
    val tables: StateFlow<List<TableEntity>> = tablesNow.held(emptyList())
    // the form's lines; the first says Main until the store has a room of that name
    val lines = MutableStateFlow(listOf(RoomLine(Uuid7.next(), name = "Main")))
    // a line's table ids, minted once for the number it asks for
    private val tableIds = HashMap<String, List<String>>()

    // ---- the printers ----
    // made or changed here, by id, laid over the stored ones until the pull has them
    private val newPrinters = MutableStateFlow<Map<String, PrinterEntity>>(emptyMap())
    private val printersNow: Flow<List<PrinterEntity>> = combine(store.flatMapLatest { db.ops().printersFlow(it) }, newPrinters) { all, mine ->
        val stored = all.filter { it.kind != "screen" } // a kitchen screen prints nothing
        (stored.map { p -> mine[p.id]?.copy(is_receipt = p.is_receipt, is_active = p.is_active) ?: p } + mine.values.filter { m -> stored.none { it.id == m.id } })
            .sortedByDescending { it.is_receipt }
    }
    val printers: StateFlow<List<PrinterEntity>> = printersNow.held(emptyList())
    // asked again and again while the form is open
    val usb: Flow<String?> = flow { while (true) { emit(printing.usbPrinter()); delay(2000) } }
    val paired: Flow<List<Pair<String, String>>> = flow { while (true) { emit(printing.pairedDevices()); delay(3000) } }
    fun bluetoothAllowed(): Boolean = printing.bluetoothAllowed()

    // ---- the staff ----
    private val newPeople = MutableStateFlow<List<StaffMember>>(emptyList())
    private val pinNow = MutableStateFlow<Set<String>>(emptySet())
    private val peopleNow: Flow<List<StaffMember>> = combine(store.flatMapLatest { staffRepo.staff(it) }, newPeople, pinNow) { stored, mine, pins ->
        (stored + mine.filterNot { m -> stored.any { it.employee.id == m.employee.id } }).map {
            // given a PIN a moment ago: the hash is the server's, and comes with the pull
            if (it.employee.id in pins && !it.hasPin) it.copy(employee = it.employee.copy(pin_hash = "set")) else it
        }
    }
    val people: StateFlow<List<StaffMember>> = peopleNow.held(emptyList())
    // the roles someone can be added with: every one but the owner's
    val roles: StateFlow<List<RoleEntity>> = db.staff().roles().map { all -> all.filterNot { "*" in perms(it.permissions) }.sortedBy { it.name.lowercase() } }.held(emptyList())
    // With someone signed in, whether they or the approver may manage staff.
    // With nobody signed in, null: the login that set the tablet up is the one
    // asked, and only the server knows whose it is.
    val mayStaff: Boolean? = staff.current.value?.let { it.can("employees.edit") || approver?.can("employees.edit") == true }
    // the server said no to that login: a manager's
    val refusedStaff = MutableStateFlow(false)

    // ---- what the business has, read once all of it has been read ----
    val facts: StateFlow<SetupFacts?> = combine(
        combine(settingsNow, companyNow) { s, c -> s to c },
        combine(catsNow, db.service().itemCount(), waiting) { cats, n, mine -> cats.size to n + mine.size },
        tablesNow, printersNow, peopleNow,
    ) { (s, c), (cats, items), t, p, who ->
        SetupFacts(
            retail = s.retail, items = items, categories = cats,
            tables = t.size, rooms = t.map { it.area.trim().lowercase() }.distinct().size,
            printers = p.map { it.name }, address = c.address, phone = c.phone,
            pins = who.count { it.hasPin },
        )
    }.map<SetupFacts, SetupFacts?> { it }.held(null)

    fun isDone(step: SetupStep): Boolean = facts.value?.let { SetupSteps.done(step, it) } ?: false

    // ---- saving ----
    // One save at a time. What went wrong is said on the step that asked.
    val busy = MutableStateFlow(false)
    val problem = MutableStateFlow<String?>(null)
    fun clear() { problem.value = null }

    // Asks the server, and when the person signed in may not, asks for
    // someone who may and sends it again with them, as the item sheet does.
    private fun <T> save(ask: suspend (StaffMember?) -> Result<T>, by: StaffMember? = approver, asked: Boolean = false, done: (T) -> Unit) {
        if (busy.value) return
        viewModelScope.launch {
            busy.value = true
            problem.value = null
            val out = ask(by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && !asked) approvals.ask(need.permission, need.what) { who -> save(ask, who, true, done) }
            else out.fold(done) { e ->
                val said = e.message ?: "That did not work"
                // nobody is signed in and the server refused the tablet's own login: it is a manager's
                if (said == StaffForm.refused("forbidden") && staff.current.value == null) refusedStaff.value = true
                problem.value = said
            }
        }
    }

    // A category in the next of the twelve colours no category has.
    fun addCategory(name: String, done: () -> Unit = {}) {
        val used = categories.value.mapNotNull { it.color?.uppercase() }.toSet()
        val colour = CategoryForm.SWATCHES.firstOrNull { it.uppercase() !in used } ?: CategoryForm.SWATCHES[categories.value.size % CategoryForm.SWATCHES.size]
        val read = CategoryForm.read(name, colour).getOrElse { problem.value = it.message; return }
        save({ by -> service.saveCategory(null, read, retail, by) }) { id ->
            newCats.value = newCats.value + CategoryEntity(id = id, tenant_id = tenant, name = read.name, color = read.color, sort_order = Int.MAX_VALUE)
            category.value = id
            done()
        }
    }

    // An item in the category on show, at a fixed price.
    fun addItem(name: String, price: String, barcode: String, done: () -> Unit = {}) {
        val cat = category.value ?: run { problem.value = "Start with a category"; return }
        val read = ItemForm.read(name, price, false, barcode).getOrElse { problem.value = it.message; return }
        save({ by -> service.saveItem(null, read, cat, true, retail, by) }) { id ->
            newItems.value = newItems.value + ItemEntity(id = id, tenant_id = tenant, category_id = cat, name = read.name, price = read.price, barcode = read.barcode)
            done()
        }
    }

    // The rooms the store has, with how many tables each.
    fun rooms(all: List<TableEntity>): List<Pair<String, Int>> =
        all.groupBy { it.area.trim().lowercase() }.values.map { it.first().area.trim() to it.size }

    // Every room typed, a room at a time: one that was taken leaves the form
    // and joins the store's rooms; the first refusal stops the rest, which
    // stay typed. A second try sends a room's tables with the ids it had.
    fun addRooms(done: () -> Unit) {
        if (busy.value) return
        val typed = lines.value
        val read = TableLayout.read(typed.map { Triple(it.name, it.count, it.seats) }, rooms(tables.value).map { it.first }).getOrElse { problem.value = it.message; return }
        val plan = TableLayout.plan(read, tables.value.map { it.name })
        viewModelScope.launch {
            busy.value = true
            problem.value = null
            for ((i, room) in read.withIndex()) {
                val line = typed[i]
                val ids = tableIds.getOrPut("${line.key}:${room.count}") { List(room.count) { Uuid7.next() } }
                val out = service.addTables(room.name, plan[i], ids, approver)
                if (out.isFailure) { problem.value = out.exceptionOrNull()?.message ?: "That did not work"; break }
                newTables.value = newTables.value + plan[i].mapIndexed { n, t ->
                    TableEntity(id = ids[n], tenant_id = tenant, store_id = storeId, name = t.name, area = t.area, seats = t.seats, x = t.x, y = t.y, w = t.w, h = t.h, sort_order = Int.MAX_VALUE)
                }
                lines.value = lines.value.filterNot { it.key == line.key }
            }
            busy.value = false
            if (problem.value == null) { lines.value = listOf(RoomLine(Uuid7.next())); done() }
        }
    }

    // The test page of a printer whose form is still open: sent from what was
    // typed, before anything is saved. Null when it was sent; else why not.
    suspend fun testPrinter(id: String, p: PrinterForm.Printer): String? =
        printing.trial(PrinterForm.entity(p, id, tenant, storeId), Docs.test(p.name, Paper(EscPos.columnsFor(p.paper), 3, true)))
            .exceptionOrNull()?.let { it.message ?: "${p.name} did not print" }

    // The test page of a printer the store has.
    suspend fun testSaved(printer: PrinterEntity): String? =
        printing.send(printer, Docs.test(printer.name, printing.paper(printer)), "Test page").exceptionOrNull()?.let { it.message ?: "${printer.name} did not print" }

    // onePrinter: whether kitchen orders print on it too; null leaves that as it is.
    fun savePrinter(id: String, p: PrinterForm.Printer, onePrinter: Boolean?, done: () -> Unit) =
        save({ by -> service.savePrinter(id, p, onePrinter, by) }) {
            // the first printer of a store prints its receipts
            newPrinters.value = newPrinters.value + (id to PrinterForm.entity(p, id, tenant, storeId).copy(is_receipt = printers.value.none { it.id != id && it.is_receipt }))
            done()
        }

    fun saveCompany(c: CompanyForm.Company, done: () -> Unit) =
        save({ by -> service.saveCompany(c, by) }) {
            savedCompany.value = c
            viewModelScope.launch { session.setBusinessName(c.name) } // the start screen's "Business name"
            done()
        }

    fun setPin(member: StaffMember, pin: String, done: () -> Unit) {
        if (!PinHash.isPin(pin)) { problem.value = "A PIN is 4 digits"; return }
        save({ by -> service.setPin(member.employee.id, pin, by) }) {
            pinNow.value = pinNow.value + member.employee.id
            done()
        }
    }

    // id: minted when the sheet opened, so a second try adds nobody twice.
    fun addStaff(id: String, name: String, role: RoleEntity?, pin: String, done: () -> Unit) {
        val (called, code) = StaffForm.read(name, pin).getOrElse { problem.value = it.message; return }
        if (role == null) { problem.value = "Pick a role"; return }
        save({ by -> service.addStaff(id, called, role.id, code, by) }) {
            newPeople.value = newPeople.value + StaffMember(EmployeeEntity(id = id, tenant_id = tenant, name = called, pin_hash = "set", role_id = role.id), role.name, perms(role.permissions), null)
            done()
        }
    }

    // "Open the till": the set-up is finished for every tablet of the business.
    fun finish(done: () -> Unit) {
        viewModelScope.launch {
            service.finishSetup(approver)
            done()
        }
    }
}
