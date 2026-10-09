# The tablet's first-run set-up, the till: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** after "Name this till", a new business is walked through its menu, tables, printer, business
details and staff PINs on the tablet, ends on a summary, and can open that summary again from the start
screen and from Settings.

**Architecture:** what can be decided without a screen sits in `core/data` and is unit-tested first
(`SetupSteps`, `TableLayout`, three forms). `ServiceRepository` gains the six calls, asked online as
`item.save` is. `feature/setup` holds one view model, the frame, the summary, the wait and a file a step.
`AppNav` gains three routes. Room does not change.

**Tech stack:** Kotlin, Jetpack Compose, Hilt, Room (unchanged), JUnit 4.

**Spec:** `docs/superpowers/specs/2026-10-09-first-run-setup-design.md`. The server plan,
`2026-10-09-first-run-setup-server.md`, is built first: 0089 must be on dev.

**Rules of this folder:** another session commits here. Stage only the files a task names; re-read a file's
committed version before editing it. Commit on `restopos`; never push a tag. Test on `easypay_claude_till`
(port 5586) and never on the owner's emulator: check the screen before every tap.

**Commands.** A test class: `android/gradlew -p android :app:testDebugUnitTest --tests "*NameTest*"`. All
of them: `android/gradlew -p android :app:testDebugUnitTest`. The build:
`android/gradlew -p android :app:assembleDebug`.

**Paths.** `main/` is `android/app/src/main/java/com/restopos/`, `test/` is
`android/app/src/test/java/com/restopos/`.

---

### Task 1: a PIN's hash, made on the tablet

**Files:** modify `main/core/common/PinHash.kt`; test `test/core/common/PinHashTest.kt` (it exists: add to
it).

- [ ] **Step 1: tests.**

  ```kotlin
  @Test fun `a hash is made as the back office makes it`() {
      // web/lib/pin.ts, hashPin("1234", Buffer.alloc(16, 7))
      assertEquals(
          "pbkdf2-sha256\$20000\$BwcHBwcHBwcHBwcHBwcHBw==\$e9J4dc709SPTq5CLB1eFvtyPhs9JnBATLVf107XfVaI=",
          PinHash.make("1234", ByteArray(16) { 7 }),
      )
  }
  @Test fun `a made hash is the one the till checks, and no two are alike`() {
      val h = PinHash.make("0420")
      assertTrue(PinHash.matches("0420", h))
      assertFalse(PinHash.matches("0421", h))
      assertNotEquals(h, PinHash.make("0420"))
      // the shape the server takes (0089, pin_hash_ok)
      assertTrue(Regex("""^pbkdf2-sha256\$20000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$""").matches(h))
  }
  @Test fun `a PIN is four digits`() {
      assertTrue(PinHash.isPin("0007"))
      listOf("", "123", "12345", "12a4", "١٢٣٤").forEach { assertFalse(it, PinHash.isPin(it)) }
  }
  ```

- [ ] **Step 2: fail** (`--tests "*PinHashTest*"`): `make` and `isPin` are unresolved.
- [ ] **Step 3: implement**, inside `object PinHash`:

  ```kotlin
  const val ROUNDS = 20_000
  fun isPin(pin: String): Boolean = pin.length == 4 && pin.all { it in '0'..'9' }
  // A new hash, as web/lib/pin.ts makes one. Only a test gives the salt.
  fun make(pin: String, salt: ByteArray = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }): String {
      val hash = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(PBEKeySpec(pin.toCharArray(), salt, ROUNDS, 256)).encoded
      val b64 = Base64.getEncoder()
      return listOf("pbkdf2-sha256", ROUNDS.toString(), b64.encodeToString(salt), b64.encodeToString(hash)).joinToString("$")
  }
  ```

- [ ] **Step 4: pass. Step 5: commit.**

### Task 2: which steps, which are done, and the mark

**Files:** create `main/core/data/SetupSteps.kt`, `test/core/data/SetupStepsTest.kt`; modify
`main/core/data/PosSettings.kt`, `test/core/data/PosSettingsTest.kt`.

```kotlin
enum class SetupStep { Menu, Tables, Printer, Company, Staff }

// What the business has, as far as the set-up asks. printers: their names, the receipt printer first,
// kitchen screens left out.
data class SetupFacts(
    val retail: Boolean, val items: Int, val categories: Int, val tables: Int, val rooms: Int,
    val printers: List<String>, val address: String, val phone: String, val pins: Int,
)

object SetupSteps {
    fun of(retail: Boolean): List<SetupStep>          // a shop has no Tables
    fun done(step: SetupStep, f: SetupFacts): Boolean
    fun first(f: SetupFacts): SetupStep?              // the first that is not done; null when all are
    fun title(step: SetupStep, retail: Boolean): String
    fun line(step: SetupStep, f: SetupFacts): String  // the summary's words for it
    enum class After { Wait, SetUp, Till }
    // After "Name this till": nothing is decided until a whole pull has finished since the till was registered.
    fun after(registeredAt: Long, lastPull: Long?, settings: PosSettings): After
}
```

`PosSettings` gains `val setupOpen: Boolean = false`, read as `d.str("setup") == "open"`.

- [ ] **Step 1: tests.**
  - `of(false)` is Menu, Tables, Printer, Company, Staff; `of(true)` the same without Tables.
  - `done`: Menu with `items >= 1`; Tables `tables >= 1`; Printer `printers.isNotEmpty()`; Company with a
    non-blank address or phone; Staff `pins >= 1`. Each false on empty facts.
  - `first`: empty restaurant facts give Menu; with items, Tables; a shop with items gives Printer; all
    done gives null.
  - `title`: "Menu" and, for a shop, "Products"; "Tables"; "Printer"; "Business details"; "Staff and PINs".
  - `line`, done: "43 items in 8 categories", "1 item in 1 category", a shop "43 products in 8 categories";
    "18 tables in 2 rooms", "1 table in 1 room"; "Receipt", and with two more printers "Receipt and 2
    more"; the address's first line, or the phone when there is no address; "3 people have a PIN",
    "1 person has a PIN".
  - `line`, not done: "Nothing to sell yet"; "No tables: orders are counter sales and takeaways";
    "No printer: nothing prints and the cash drawer stays shut"; "No address or phone on the receipt";
    "No PINs: the register opens with one tap".
  - `after`: `lastPull` null, or earlier than `registeredAt`, is Wait whatever the settings say; later with
    `setupOpen` is SetUp; later without it is Till.
  - `PosSettings.parse`: no `setup` key gives `setupOpen` false; `"setup":"open"` true; `"setup":"done"`
    false.
- [ ] **Step 2: fail. Step 3: implement. Step 4: pass. Step 5: commit.**

### Task 3: the tables' numbers and places

**Files:** create `main/core/data/TableLayout.kt`, `test/core/data/TableLayoutTest.kt`.

```kotlin
object TableLayout {
    const val MOST = 60
    class Room(val name: String, val count: Int, val seats: Int)
    class Table(val name: String, val area: String, val seats: Int, val x: Int, val y: Int, val w: Int, val h: Int)

    // The number the next table takes: one more than the highest whole number among the store's names.
    fun next(names: List<String>): Int = (names.mapNotNull { it.trim().toIntOrNull() }.maxOrNull() ?: 0) + 1

    // One room on the 100 by 60 plan, in rows, numbered from `from`.
    fun grid(room: Room, from: Int): List<Table> {
        val n = room.count
        val cols = ceil(sqrt(n * 100.0 / 60.0)).toInt().coerceAtLeast(1)
        val rows = ceil(n / cols.toDouble()).toInt()
        val cw = 100.0 / cols
        val ch = 60.0 / rows
        val side = floor(minOf(cw, ch) * 0.6).toInt().coerceIn(4, 12)
        return (0 until n).map { i ->
            val x = floor((i % cols) * cw + (cw - side) / 2).toInt()
            val y = floor((i / cols) * ch + (ch - side) / 2).toInt()
            Table((from + i).toString(), room.name, room.seats, x, y, side, side)
        }
    }

    // Every room typed, numbered on from the store's last table and from one another.
    fun plan(rooms: List<Room>, names: List<String>): List<List<Table>> {
        var from = next(names)
        return rooms.map { r -> grid(r, from).also { from += r.count } }
    }

    // The lines of the form (name, how many, seats at each), read: or why not.
    // existing: the rooms the store has.
    fun read(lines: List<Triple<String, String, String>>, existing: List<String>): Result<List<Room>>
}
```

- [ ] **Step 1: tests.**
  - `grid` of 12: 5 columns, 3 rows; every side 12; the first at x 4, y 4; names "1" to "12".
  - `grid` of 60: side 6; of 1: side 12 at x 19, y 24.
  - For n in 1..60: every table inside the plan (`x >= 0`, `y >= 0`, `x + w <= 100`, `y + h <= 60`), every
    side between 4 and 12, and no two tables overlapping.
  - `next`: of none is 1; of `"1","2","Bar","12a","7"` is 8.
  - `plan` of Main 12 and Terrace 6 with no names: Terrace is "13" to "18". With names up to "20": Main
    starts at "21".
  - `read`: a name is trimmed and cut at 30; blank seats are 4. Refused with: "Give the room a name";
    "Type how many tables" (blank, 0, `abc`); "60 tables is the most for one room here. Add a second room,
    or lay it out in the back office." (61); "Seats are between 1 and 99" (0, 100); "Two rooms are called
    Main" (whatever the capitals); "There is already a room called Main. Its tables are changed in the back
    office." (an existing room, whatever the capitals). No lines at all: "Add a room".
- [ ] **Step 2: fail. Step 3: implement. Step 4: pass. Step 5: commit.**

### Task 4: the printer's, the staff's and the company's forms

**Files:** create `main/core/data/PrinterForm.kt`, `StaffForm.kt`, `CompanyForm.kt`, and a test for each in
`test/core/data/`.

```kotlin
object PrinterForm {
    class Printer(val name: String, val kind: String, val address: String?, val paper: Int)
    fun read(name: String, kind: String, address: String, paper: Int): Result<Printer>
    // a printer that is not stored, for the test page
    fun entity(p: Printer, id: String, tenant: String, store: String): PrinterEntity
    fun connection(kind: String, address: String?): String   // "Network · 192.168.1.50", "USB", "Bluetooth · MPT-II"
    fun hint(kind: String): String                           // what to check when the test page did not print
    fun refused(code: String?): String
}
object StaffForm {
    fun read(name: String, pin: String): Result<Pair<String, String>>
    // The first PIN goes to someone who may open the day: with a PIN in use the till asks for one, and
    // the day is opened by someone allowed to.
    // Who that is: someone who may open the day and set up the till. The owner and a manager may; a
    // cashier may open the day and approve nothing, so a till where only a cashier had a PIN would have
    // nobody to ask.
    fun leads(member: StaffMember): Boolean = member.can("shift.open_close") && member.can("settings.device")
    fun mayHavePin(member: StaffMember, all: List<StaffMember>): Boolean = leads(member) || mayAdd(all)
    fun mayAdd(all: List<StaffMember>): Boolean = all.any { it.hasPin && leads(it) }
    fun refused(code: String?): String
}
object CompanyForm {
    class Company(val name: String, val address: String, val phone: String, val brn: String, val vat: String)
    fun read(name: String, address: String, phone: String, brn: String, vat: String): Result<Company>
    fun top(c: Company): List<String>   // the top of a receipt, as Docs.head prints it
    fun refused(code: String?): String
}
```

- [ ] **Step 1: tests.**
  - `PrinterForm.read`: the name trimmed and cut at 40, blank "Give the printer a name". Network takes
    `192.168.1.50` and `192.168.1.50:9100`; `printer.local`, blank and `999.1.1.1` are "Type the printer's
    IP address, for example 192.168.1.50" (the back office's pattern,
    `^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(:\d{2,5})?$`). Bluetooth takes `MPT-II`
    and `00:11:22:AA:BB:CC`; blank or an IP address is "Pick the printer among the devices paired with this
    tablet". USB has no address whatever was typed. Paper other than 58 is 80.
  - `entity` carries the name, kind, address and paper, `feed_lines` 3, `cut` true, `is_receipt` true.
  - `connection` as in the comment above. `hint`: network "Check that the printer is switched on, on the
    same network as the tablet, and that the address is the one on its self-test page."; USB "Check the
    cable at both ends, that the printer is switched on, and that the tablet was allowed to use it.";
    Bluetooth "Check that the printer is switched on, near the tablet, and paired with it in the tablet's
    Bluetooth settings."
  - `PrinterForm.refused`: `bad-address` "The server did not take that address. Check it and try again.";
    `bad-printer` "That printer is no longer there. Close this and open it again."; `bad-store` "This
    till's store is no longer there."; `forbidden` "You are not allowed to set up printers. Ask a
    manager."; `unknown-op` "The server has to be updated before a printer can be added from a till.";
    `conflict`, null and anything else as `ItemForm.refused` words them.
  - `StaffForm.read`: the name trimmed and cut at 80, blank "Give them a name"; a PIN that is not four
    digits "A PIN is 4 digits".
  - `mayHavePin` and `mayAdd`, with members built from `EmployeeEntity`: while nobody has a PIN, a waiter
    and a cashier with `shift.open_close` alone may not have one, a manager with `shift.open_close` and
    `settings.device` and an owner with `*` may, and nobody can be added; once the owner or the manager
    has one, the waiter and the cashier may and people can be added. A cashier's PIN alone opens nothing
    for the others.
  - `StaffForm.refused`: `forbidden` "Only the owner can add staff or set a PIN. Ask the owner, or do it in
    the back office, under Staff."; `bad-role` "That role is no longer there. Pick another."; `bad-pin`
    "That PIN could not be saved. Type it again."; `unknown-staff` "That person is no longer there.";
    `unknown-op` "The server has to be updated before staff can be added from a till."
  - `CompanyForm.read`: lengths 80, 240, 40, 30, 30; a blank name "The business needs a name".
  - `top`: the name, each line of the address, "Tel: 5 123 4567", "BRN: C12345678", "VAT: VAT27000000"; a
    blank phone, BRN or VAT has no line.
  - `CompanyForm.refused`: `forbidden` "You are not allowed to change the business's details. Ask a
    manager."; `unknown-op` "The server has to be updated before these can be changed from a till."
- [ ] **Step 2: fail. Step 3: implement. Step 4: pass. Step 5: commit.**

### Task 5: the repository, the test page, and what the tablet keeps

**Files:** modify `main/core/data/Service.kt` (beside `adjustStock`), `main/core/data/StaffRepository.kt`
(beside `Approvals`), `main/core/print/Printing.kt`, `main/core/sync/Sync.kt` (`SessionStore`),
`main/feature/auth/AuthViewModels.kt`.

- [ ] **Step 1: `SetupDoor`**, in `StaffRepository.kt`:

  ```kotlin
  // Who approved the set-up being opened from Settings, when the person signed in could not open it
  // alone: sent as approved_by with what it saves.
  @Singleton
  class SetupDoor @Inject constructor() { var approver: StaffMember? = null }
  ```

- [ ] **Step 2: `ServiceRepository`.**

  ```kotlin
  suspend fun addTables(room: String, tables: List<TableLayout.Table>, ids: List<String>, approver: StaffMember? = null): Result<Unit>
  suspend fun savePrinter(id: String, p: PrinterForm.Printer, onePrinter: Boolean?, approver: StaffMember? = null): Result<Unit>
  suspend fun saveCompany(c: CompanyForm.Company, approver: StaffMember? = null): Result<Unit>
  suspend fun addStaff(id: String, name: String, roleId: String, pin: String, approver: StaffMember? = null): Result<Unit>
  suspend fun setPin(employeeId: String, pin: String, approver: StaffMember? = null): Result<Unit>
  suspend fun finishSetup(approver: StaffMember? = null)
  ```

  - Each of the first five is `runCatching { staff.allow(...); ask(type, refused, payload) }`, as
    `adjustStock` is. `addTables`, `savePrinter`, `saveCompany`: `staff.allow("settings.device", "set this
    till up", approver)`. `addStaff`, `setPin`: `staff.allow("employees.edit", "add staff or set a PIN",
    approver)`.
  - Payloads are the server plan's: `tables.add {store_id, area, tables: [{id, name, seats, shape:
    "square", x, y, w, h}]}` with `ids[i]` for table `i`; `printer.save {id, store_id, name, kind, address
    ("" for none), paper_mm}` and `one_printer` only when not null; `company.save {name, address, phone,
    brn, vat}`; `staff.save {id, name, role_id, pin_hash}`; `staff.set_pin {employee_id, pin_hash}`.
  - The store is `session.storeId() ?: error("This till is not set up for a store yet.")`.
  - `approved_by` is `staff.approvedBy(permission, approver)`, put in when it is not null, as `saveItem`
    does. Who the change is made by is `ask`'s own rule and is not touched: the person signed in, or the
    till's login when nobody is. Task 14 sees that someone who opens the set-up with their PIN is signed
    in for it, so a manager is never given the owner's rights by the login.
  - The hash: `withContext(Dispatchers.Default) { PinHash.make(pin) }`.
  - Refusals: tables have no form object, so `addTables` words its own, in a private function beside
    it: `room-exists` "There is already a room of that name."; `name-taken` "A table already has one of those numbers. Close this
    and try again."; `too-many` "A store holds 300 tables at most."; `bad-store` "This till's store is no
    longer there."; `forbidden` "You are not allowed to set up tables. Ask a manager."; `unknown-op` "The
    server has to be updated before tables can be added from a till."; the rest as `ItemForm.refused`.
    The others pass `PrinterForm::refused`, `CompanyForm::refused`, `StaffForm::refused`.
  - `finishSetup`: `db.outbox().enqueue(op("setup.finish", buildJsonObject { approver?.let {
    put("approved_by", it.employee.id) } }))`, `session.setSetupClosed(true)`, `pushNow(context)`.
- [ ] **Step 3: `Printing`.**

  ```kotlin
  // A print to a printer that is not stored: the test page of one being set up. Nothing is kept of it,
  // so a failed one is not in the Printers page's list.
  suspend fun trial(p: PrinterEntity, bytes: ByteArray): Result<Unit> = deliver(p, bytes)
  // The devices paired with this tablet, by name and address; none when Bluetooth is not allowed or off.
  fun pairedDevices(): List<Pair<String, String>>
  // The printer plugged into this tablet, by the name it gives itself; null when there is none.
  fun usbPrinter(): String?
  ```

  `pairedDevices` reads `adapter.bondedDevices` as `paired()` does, behind `bluetoothAllowed()`;
  `usbPrinter` is the first of `manager.deviceList.values` with a `printerInterface`, its `productName` or
  "USB printer".
- [ ] **Step 4: `SessionStore`.** `setupClosed: Flow<Boolean>` and `setSetupClosed(Boolean)` (key
  `setup_closed`); `registeredAt(): Long` (0 when never) and `setRegisteredAt(Long)` (key `registered_at`).
  `save(tenant, store, device)` removes `setup_closed`: a tablet set up again starts afresh.
- [ ] **Step 5: `StoreDeviceViewModel`.** In `Register`'s `onSuccess`, before `SyncScheduler.pullNow`:
  `session.setRegisteredAt(System.currentTimeMillis())`.
- [ ] **Step 6:** the unit suite and `assembleDebug`. **Step 7: commit.**

### Task 6: the card's pieces are shared, and the demo-menu link goes

**Files:** create `main/feature/auth/SetupParts.kt`; modify `main/feature/auth/AuthScreens.kt`,
`AuthViewModels.kt`, `main/core/network/ApiClient.kt`.

- [ ] **Step 1:** move `SetupCard`, `Heading`, `Problem`, `SetupField`, `MainKey` and `QuietLink` out of
  `AuthScreens.kt` into `SetupParts.kt`, unchanged but for `internal` in place of `private`, and
  `SetupCard(width: Dp = 520.dp, content: ...)` in place of its fixed width.
- [ ] **Step 2:** the "Seed Le Flamboyant demo menu" row goes from `StoreDeviceScreen`, with
  `StoreDeviceAction.SeedDemo`, its branch in the view model, `Pick.notice` and `ApiClient.seedDemo()`.
  The API's `/seed-demo` is left: tills up to 0.6.3 still have the link.
- [ ] **Step 3:** `assembleDebug`. **Step 4: commit.**

### Task 7: the view model

**Files:** create `main/feature/setup/SetupViewModel.kt`.

`@HiltViewModel class SetupViewModel(db, session, service, staffRepo: StaffRepository, staff: StaffSession,
printing, door: SetupDoor, @ApplicationContext context)`.

- [ ] **Step 1: what it reads**, each a `StateFlow` held while the screen is up:
  - `settings` (`db.ops().settingsFlow()` through `PosSettings.parse`), `business` (the settings'
    `companyName`, else `session.businessName()`), `retail`, `open` (`settings.setupOpen` and not
    `session.setupClosed`).
  - `categories` (`db.catalog().categories()`), `counts` (`itemsPerCategory()`), `items(categoryId)`
    (`db.service().items(cat, "")`), `tables` (`db.tables().tables(store)`), `printers`
    (`db.ops().printersFlow(store)` without `kind == "screen"`), `people` (`staffRepo.staff(store)`),
    `roles` (`db.staff().roles()`).
  - `facts: StateFlow<SetupFacts?>`, null until every one of those has been read once.
  - For the Printer step, asked again while its form is open: `usb: StateFlow<String?>`
    (`printing.usbPrinter()`, every two seconds) and `paired: StateFlow<List<Pair<String, String>>>`
    (`printing.pairedDevices()`, every three).
  - `approver = door.approver`. `mayStaff: StateFlow<Boolean?>`: with someone signed in, whether they or
    the approver hold `employees.edit`; with nobody signed in, null (the till's login is the one asked,
    and the server says). `refusedStaff: StateFlow<Boolean>`: true from the first `forbidden` a staff save
    is answered while nobody is signed in.
- [ ] **Step 2: what was saved on this visit.** A pull that `ask` starts brings each row; until it lands
  the view model shows what it sent.
  - `saved: StateFlow<Map<SetupStep, String>>`: for a step saved on this visit, the summary's line for it.
    `isDone(step)` is `SetupSteps.done(step, facts)` or `step in saved`. `lineOf(step)` is the facts' line
    when the facts have it done, else the saved line, else the facts' line.
  - The Menu step's lists also hold the categories and items just added, as entities made from what was
    sent, each dropped when the database has its id. The Staff step's list holds the people just added
    and the ids just given a PIN, the same way; the Tables step's rooms and the Printer step's list
    likewise.
- [ ] **Step 3: what it does**, each returning what went wrong or null, and none thrown:
  - `addCategory(name)`: `CategoryForm.read(name, colour)` with the first of `CategoryForm.SWATCHES` no
    category uses (else the one at the count of categories modulo twelve), then `service.saveCategory`.
  - `addItem(categoryId, name, price, barcode)`: `ItemForm.read(name, price, open = false, barcode)`, then
    `service.saveItem(null, item, categoryId, available = true, shop = retail)`.
  - `addRooms(lines)`: `TableLayout.read`, `TableLayout.plan` against the names of `tables`, then one
    `service.addTables` a room, in order, stopping at the first refusal. The ids of a room are minted once
    and kept with its line, so a second try sends the same ones. Rooms that were taken move to the list
    of rooms and leave the form.
  - `testPrinter(p)`: `printing.trial(PrinterForm.entity(p, id, tenant, store), Docs.test(p.name,
    Paper(EscPos.columnsFor(p.paper), 3, true)))`. `testSaved(printer)`: `printing.send(printer,
    Docs.test(printer.name, printing.paper(printer)), "Test page")`.
  - `savePrinter(id, p, onePrinter)`, `saveCompany(c)` (and `session.setBusinessName(c.name)` once it is
    taken), `setPin(member, pin, by)`, `addStaff(id, name, roleId, pin, by)`.
  - A new printer's id and a new person's id are minted when the form or the sheet opens
    (`remember { Uuid7.next() }`) and kept until the server has taken them: a second try after a lost
    answer sends the same id, and the server changes nothing twice.
  - `finish()`: `service.finishSetup(approver)`.
  - Every call that takes an approver is given `approver`. The two staff calls take `by`, whoever answered
    the till's own request for `employees.edit`, in its place when there is one, and hand a
    `NeedsApproval` on with `.orAsk()` as `ItemEditor.save` does, so that a manager who is signed in is
    asked for the owner's PIN and is not left at a dead end.
- [ ] **Step 4:** `assembleDebug`. **Step 5: commit.**

### Task 8: the frame, the summary and the wait

**Files:** create `main/feature/setup/SetupScreen.kt`, `main/feature/setup/SetupWait.kt`.

- [ ] **Step 1: the frame.** `@Composable fun SetupScreen(first: Boolean, onDone: () -> Unit, vm:
  SetupViewModel = hiltViewModel())`.
  - `SetupCard(width = 860.dp)`, filling the height it is given, its body scrolling inside it.
  - Head: the mark, "Set up <business>", and on the right "2 of 5" over a dot a step: a tick in a done
    one, a ring on the one open. On the summary the head is "<business> is ready to sell" when there is
    something to sell, else "<business> has nothing to sell yet", and no count.
  - Where it is, kept through a rebuilt screen (`rememberSaveable`): a step's name, or the summary. Before
    the facts are read: a spinner under "Reading what <business> has". Then, on a first run, the first step
    not done, or the summary; opened later, the summary.
  - The step's body in an `AnimatedContent` keyed by where it is: the new one comes in from the side it
    lies on, with `Motion`'s timings, as the till's other screens change.
  - `StepFoot(main: String, ready: Boolean, busy: Boolean, onMain: () -> Unit, skip: (() -> Unit)?)`: a
    quiet **Skip for now** on the left when `skip` is given, the `MainKey` on the right. Each step ends
    with one.
  - Going on: the step after this one, the summary after the last. A step opened from the summary returns
    to the summary.
  - `BackHandler`: the step before; nothing on the first step of a first run; from the summary, the last
    step on a first run and `onDone()` when opened later.
- [ ] **Step 2: the summary.** A row for each of `SetupSteps.of(retail)`: a green tick or an empty ring,
  the title, `vm.lineOf(step)`, and a quiet key, **Do it now** on one not done and **Change** on one that
  is. Under them, in the quiet colour: "Taxes, discounts, add-ons, the receipt's logo, more printers and
  the plan's exact layout are set in the back office" and, when `BuildConfig.BACK_OFFICE_URL` is not
  blank, its host after a colon. Then what comes next: with a PIN in use "Next: clock in, then open the
  day.", else "Next: tap Open register." The main key: while `vm.open`, **Open the till** (`vm.finish()`,
  then `onDone()`); otherwise **Back to the till** (`onDone()`).
- [ ] **Step 3: the wait.** `@Composable fun SetupWaitScreen(onSetUp: () -> Unit, onTill: () -> Unit)`
  with a small view model of its own that clears `door.approver` and gives
  `SetupSteps.after(session.registeredAt(), lastPull, settings)` as a flow.
  - `Wait`: `Heading("Getting <business> ready", "Reading its products, staff and settings. This takes a
    moment.")` and the spinner of "Name this till". After 20 seconds of it: `Problem("This is taking
    longer than it should. Check the tablet's connection.")`, `MainKey("Try again")`
    (`SyncScheduler.pullNow`, and the 20 seconds start again) and `QuietLink("Open the till")` (`onTill`).
  - `SetUp` calls `onSetUp` once; `Till` calls `onTill` once.
- [ ] **Step 4:** `assembleDebug`. **Step 5: commit.**

### Task 9: the Menu step

**Files:** create `main/feature/setup/MenuStep.kt`.

- [ ] **Step 1:** two panes. Left, 240 dp: the categories (dot, name, how many), the chosen one lit; under
  them a box "New category" whose Done adds it and chooses it. Right: the chosen category's items, name
  and price, and under them one line: **Name**, **Price**, in a shop **Barcode**, and **Add**. Add clears
  the line and puts the cursor back in Name; the keyboard's Next walks the boxes and Done on the last one
  adds. With no category the right pane says "Start with a category: Starters, Drinks, whatever you call
  them."
- [ ] **Step 2:** what went wrong (`vm.addItem`, `vm.addCategory`) shows as a `Problem` above the line and
  what was typed stays.
- [ ] **Step 3:** a tap on an item opens the till's `ItemSheet` (an `ItemEditor(service, approvals, scope,
  shop)`, `ItemEdit(item, category)`); a tap on the pencil beside the chosen category's name sets
  `CategoryEditor.editing` so `CategorySheets` opens that category.
- [ ] **Step 4:** in a shop, while the step shows, `Scanner.taking = true` (false again in `onDispose`),
  and a code from `Scanner.codes` goes into the Barcode box.
- [ ] **Step 5:** the quiet line at the foot of the body. A shop: "Many products? Import a spreadsheet in
  the back office, under Import products." A restaurant: "Add-ons and tax are set in the back office,
  under Menu." `StepFoot("Continue", ready = true, ...)`, with Skip while the step is not done.
- [ ] **Step 6:** `assembleDebug`. **Step 7: commit.**

### Task 10: the Tables step

**Files:** create `main/feature/setup/TablesStep.kt`.

- [ ] **Step 1:** the rooms the store has, each "Main · 12 tables", then the form: a line a room with
  **Room**, **Tables** and **Seats at each** (4), a cross on every line after the first, and a quiet **Add
  a room**. The first line says Main when the store has no room of that name.
- [ ] **Step 2:** the main key. With nothing typed and tables there: "Continue". Otherwise it says what is
  missing (`TableLayout.read`'s words) until the lines read, then "Save and continue": `vm.addRooms`, and
  on with the step once every room was taken. While it saves the key shows the spinner.
- [ ] **Step 3:** the quiet line: "They can be moved, renamed and given other shapes in the back office,
  under Tables." Skip while the store has no table.
- [ ] **Step 4:** `assembleDebug`. **Step 5: commit.**

### Task 11: the Printer step

**Files:** create `main/feature/setup/PrinterStep.kt`.

- [ ] **Step 1: a store with printers.** Each on a row: its name, `PrinterForm.connection`, a chip "Prints
  the receipts" on that one, and two quiet keys, **Test** (`vm.testSaved`; what it answers shows on the
  row) and **Change** (the form, filled). Under them: "More printers, and which category prints where,
  are set in the back office, under Printers." `StepFoot("Continue", ...)`.
- [ ] **Step 2: the form**, in a store with no printer and for Change.
  - **Name**, "Receipt" until changed.
  - A `Seg`: Network, USB, Bluetooth.
  - Network: **Address**, with "192.168.1.50" in it while empty, and under it "Most printers print their
    address on their self-test page."
  - USB: asked every two seconds, "The tablet sees a printer: <name>" or "No printer is plugged into this
    tablet".
  - Bluetooth: while `!printing.bluetoothAllowed()`, "A Bluetooth printer cannot be reached until the
    tablet allows it. It asks once." and a key **Allow Bluetooth** that launches the permission request as
    the Printers page does (`ActivityResultContracts.RequestPermission`,
    `Manifest.permission.BLUETOOTH_CONNECT`). Once allowed: `vm.paired` (read every three seconds) as rows
    to tap, name and address, the chosen one lit and its address the printer's; none paired, "No device is
    paired with this tablet yet."; and a quiet key **Bluetooth settings**
    (`Settings.ACTION_BLUETOOTH_SETTINGS`).
  - A `Seg`: 80 mm, 58 mm.
  - In a restaurant, when adding: a switch **Kitchen orders print on it too**, on, with "With one printer
    for everything, every kitchen order prints here." under it. Change does not show it and sends no
    `one_printer`.
- [ ] **Step 3: the test.** The main key says what is missing (`PrinterForm.read`'s words) until the form
  reads, then **Print a test page** (`vm.testPrinter`). If it could not be sent: Printing's own words as a
  `Problem`, and `PrinterForm.hint(kind)` under it. If it was sent, the form gives way to "Did it
  print?": **Yes, save it** (`vm.savePrinter`, with the id the form minted when it opened, then on with
  the step) and a quiet **No**, which returns to the form with the hint showing.
- [ ] **Step 4:** Skip while the store has no printer. `assembleDebug`. **Step 5: commit.**

### Task 12: the Business details step

**Files:** create `main/feature/setup/CompanyStep.kt`.

- [ ] **Step 1:** two columns. Left, the boxes: **Business name**, **Address** (three lines), **Phone**,
  **BRN**, **VAT number**, filled from the settings (the name from `vm.business`). Right, 300 dp wide: a
  white sheet with a torn lower edge, `CompanyForm.top` of what the boxes hold, centred in a fixed-width
  face, the name heavier, redrawn as they are typed in; above it, in the quiet colour, "The top of every
  receipt".
- [ ] **Step 2:** the main key: "Enter the business's name" while it is blank; "Save and continue" when
  something differs from what the business has (`vm.saveCompany`); "Continue" when nothing does. Skip
  while the step is not done.
- [ ] **Step 3:** `assembleDebug`. **Step 4: commit.**

### Task 13: the Staff and PINs step

**Files:** create `main/feature/setup/StaffStep.kt`.

- [ ] **Step 1:** when `vm.refusedStaff` is true (the tablet was signed in with a manager's login, and
  the server said no), only this: "Only the owner can add staff or set a PIN. Ask the owner to set this
  tablet up, or do it in the back office, under Staff." and `StepFoot("Continue", ...)`.
- [ ] **Step 2:** otherwise, at the top: "With PINs, each person clocks in and signs in with their own,
  and the till knows who rang up what. Without PINs the register opens with one tap." When `vm.mayStaff`
  is false, a second line: "Adding staff or setting a PIN needs the owner: the till will ask for the
  owner's PIN." Then everyone: name, role, and a chip, "PIN set" in green or "No PIN". A tap opens a
  sheet, "A PIN for <name>": one box that takes four digits and shows them, and **Set PIN**
  (`vm.setPin`).
- [ ] **Step 3:** someone `StaffForm.mayHavePin` says no to is dimmed, does not open, and says under their
  name "First give a PIN to the owner or a manager". **Add someone** is a key under the list, dimmed with
  the same words until `StaffForm.mayAdd`. Its sheet: **Name**, the roles as chips (every role but one
  whose permissions hold `*`), **PIN**, and **Add** (`vm.addStaff`, with the id the sheet minted when it
  opened).
- [ ] **Step 3a:** a save that needs someone else's go-ahead (`NeedsApproval`) asks for it through
  `Approvals`, as `ItemEditor` does, and is sent again with whoever approved.
- [ ] **Step 4:** `StepFoot("Continue", ...)`, with Skip while nobody has a PIN. `assembleDebug`.
  **Step 5: commit.**

### Task 14: the way in

**Files:** modify `main/app/AppNav.kt`, `main/feature/start/StartScreen.kt`,
`main/feature/staff/StaffViewModel.kt`, `main/feature/settings/SettingsScreen.kt`,
`main/feature/main/MainShell.kt`.

- [ ] **Step 1: routes.** `SETUP_WAIT = "setup-wait"`, `SETUP_FIRST = "setup-first"`, `SETUP = "setup"`.
  - `DEVICE`'s `onReady` goes to `SETUP_WAIT` (popping `DEVICE`) in place of `START`.
  - `SETUP_WAIT`: `SetupWaitScreen(onSetUp = { navigate(SETUP_FIRST) { popUpTo(0) { inclusive = true } } },
    onTill = { navigate(START) { popUpTo(0) { inclusive = true } } })`.
  - `SETUP_FIRST`: `SetupScreen(first = true, onDone = { navigate(START) { popUpTo(0) { inclusive = true } } })`.
  - `SETUP`: `SetupScreen(first = false, onDone = { nav.popBackStack() })`.
  - `StartScreen` and `MainShell` are each given `onSetUp = { nav.navigate(Routes.SETUP) }`.
  - The rule at the top of `AppNav` (a screen brought back with nobody signed in, where PINs are in use,
    returns to the start screen) is left as it is: it covers these routes.
  - `KDS` and `REAUTH` are not touched: a kitchen screen and "Sign in again" never reach the set-up.
- [ ] **Step 2: the start screen.** `StaffViewModel` gains `setupOpen: StateFlow<Boolean>` (the settings'
  `setupOpen` and not `session.setupClosed`) and `setUp(then: () -> Unit)`. Either way `door.approver` is
  set to null.
  - Where nobody has a PIN: `then()`. Nobody is signed in, and what the set-up saves is the till's
    login's, as everything on such a till is.
  - Where anyone has a PIN: `approvals.ask("settings.device", "set this till up") { member ->
    staffSession.signIn(member); then() }`. Whoever enters their PIN is signed in for the set-up, so
    what it saves is theirs and is held to their rights: a manager who opens it is not given the owner's
    rights by the till's login. They need not be clocked in. Returning to the start screen signs them out,
    as it signs anyone out.
  - It must not ask `staff.can`: on the start screen nobody is signed in, and that answers yes.
  - `Closed` and `Users` show, while `setupOpen`, a quiet key **Finish setting up** under their button,
    which calls `vm.setUp(onSetUp)`.
- [ ] **Step 3: Settings.** `SettingsViewModel.setUp(then)`: `if (staff.can("settings.device")) {
  door.approver = null; then() } else approvals.ask("settings.device", "set this till up") {
  door.approver = it; then() }`. The This till page gains a row, `Fact(VI.Screen, "Set-up", ..., button =
  "Open")`, whose detail is "The menu, the tables, the printer, the business's details and staff PINs,
  one step at a time" (a shop: without the tables), calling `vm.setUp(onSetUp)`. `SettingsScreen` and
  `MainShell` each take `onSetUp` and hand it on. The spec's "Set-up page" is this row: the set-up is a
  screen of its own, not a pane of Settings.
- [ ] **Step 4:** the unit suite and `assembleDebug`. **Step 5: commit.**

### Task 15: Help, the version, and seen on a tablet

**Files:** modify `main/feature/settings/SettingsScreen.kt` (`HELP`, `SHOP_HELP`),
`android/app/build.gradle.kts`, `android/app/src/debug/java/com/restopos/debug/DemoReceiver.kt`,
`android/app/src/debug/AndroidManifest.xml` (its comment).

- [ ] **Step 1: Help.** Last but two in `HELP`:
  `"Setting the till up" to "A new business is walked through it the first time a tablet is signed in:
  the menu, the tables, the receipt printer, what prints at the top of a receipt, and staff PINs. Any
  step can be skipped. Afterwards it is in Settings, under This till: Set-up shows what is done, and a tap
  on a line does it or changes it. A second printer for the kitchen, which category prints where, and the
  plan's exact layout are set in the back office. It needs a connection, and may need a manager; adding
  staff and setting a PIN needs the owner."`
  In `SHOP_HELP`, the same without the tables and the kitchen, "the products" for "the menu", and "Tap
  More on the top bar, then This till" for where it is.
- [ ] **Step 2: the version.** `versionCode = 11`, `versionName = "0.7.0"`.
- [ ] **Step 3: the debug build.** `DEMO_SHOP` takes `--ez setup true` and then writes `"setup":"open"`
  into the settings it makes, beside the plan. The manifest's comment says so.
- [ ] **Step 4: the whole unit suite** and `assembleDebug`.
- [ ] **Step 5: on `easypay_claude_till`**, its data cleared first, as the made-up restaurant with
  `--ez setup true` and then as the made-up shop: the start screen's key; the PIN asked of a manager; the
  summary with what the made-up business has ticked; each step's screen; what each form refuses; the test
  page to an address nothing answers at, and its hint; the Bluetooth list; Settings, This till, Set-up; no
  crash in the device log. A screenshot of each. The made-up business has no server, so every save stops
  at "This needs a connection": what the server answers is the suite's to show. Not seen there, and said
  so: the wait after "Name this till", a save going through, and the first run from a real sign-in.
- [ ] **Step 6: commit.** Update the memory file `restopos-first-run-setup`.

### Release (not part of the build)

Till 0.7.0, versionCode 11, by a tag the owner pushes when they say to go live; it carries migration 0089,
and 0088 before it if that has not gone yet. What the owner tries first, since no one else can: a client
made in `/admin`, signed in on a tablet, taken through every step with a real printer.
