# The tablet's first-run set-up: design

Asked 2026-10-09: "We need to create an onboarding flow for POS right after sign in for the first time".
The owner's answers are quoted where they decide something.

## What exists

- A tablet's first run is sign in, "Name this till", then the start screen (`AppNav.kt`: `AUTH`, `DEVICE`,
  `START`).
- A client made in `/admin` has one store, four roles, its owner (with a PIN if one was typed there),
  payment types, VAT and order types (`platform.create_tenant`, `ensure_pos_basics`). It has no categories,
  no items, no tables, no printer, no other staff, no address and no phone. So the start screen says
  "Register is locked" over a till with nothing to sell.
- The tablet makes items and categories itself (`item.save` 0084, `category.save` 0087): asked online and
  waited for (`ServiceRepository.ask`), then a pull brings the row.
- Tables (`tables/actions.ts`), printers (`lib/saves.ts`), staff and PINs (`staff/page.tsx`, `lib/pin.ts`)
  and company details (`company/page.tsx`) are the back office's only.
- The till API hands every op to `sync_push` unread (`hello.ts`, `/sync/push`): a new op is a migration,
  not an API change.
- A till is set up only under a login that holds `settings.device` (`maySetUpTills`). An op with no
  `employee_id` is done as that login. With nobody signed in by PIN, the till's own checks pass
  (`StaffSession.can` is true, `id()` is null).
- `tenants` is not in a pull; `pos_settings` is. A BRN or VAT number typed in `/admin` is written to
  `tenants` alone (`platform.set_tenant_details`), so it reaches no till and prints on no receipt until
  Company details is saved in the back office.
- "Name this till" has a link, "Seed Le Flamboyant demo menu", that puts a restaurant's menu into a shop.

## The owner's decisions

- What it does: "Tablet set-up". Not a tour of the till, and not a checklist in the back office.
- What it covers, besides something to sell: "Tables (restaurants), Printer, Staff and PINs, Business
  details". All four, on the tablet.
- Its shape: "Steps, then a summary": one step per screen with Skip on each, then a summary that can be
  opened again later.
- The design below, approved: "Yes, write it up".

## 1. When it is shown

**The mark.** `pos_settings.data.setup` is `"open"` or `"done"`. A client without the key is never shown
the set-up: every client that exists today, and any client on a server without 0089.
`platform.create_tenant` writes `"open"`, so a client made in `/admin` from 0089 on starts open
(`create_tenant_of_type`, which `/admin` calls, goes through it).

**After "Name this till".** The tablet shows "Getting <business> ready" until its first pull has finished:
`lastPull` later than the moment the till was registered. It never decides from its own tables before
that, since they are empty on every new tablet. Then it opens the set-up if the mark is `"open"`, and the
start screen otherwise. After 20 seconds without a finished pull it says so and offers **Try again** and
**Open the till**.

**It belongs to the business.** A second till of a business whose set-up is done goes to the start screen.
One named while the set-up is still open is shown it, with the finished steps ticked.

**Later.** A tablet opens on the start screen, as always. While the set-up is open the start screen has
a **Finish setting up** key. Settings has a **Set-up** page for good, for every client. Both open the
summary. On a till without PINs the key opens it with one tap, as the register opens. Where staff use
PINs, the person signed in must hold `settings.device`, or someone who does approves with their PIN, as
for the till's other manager actions. On the start screen nobody is signed in: whoever enters their PIN
there is signed in for the set-up, so what it saves is theirs and is held to their rights. A manager who
opens it cannot set a PIN, though the tablet's login is the owner's.

**Never** on a tablet set up as a kitchen screen, and never after "Sign in again".

## 2. The steps

A restaurant has five: Menu, Tables, Printer, Business details, Staff and PINs. A shop has four: Products,
Printer, Business details, Staff and PINs. Staff and PINs is last because a PIN changes the till: once
anyone has one, the start screen asks for a PIN.

**The frame.** One card in the middle of the screen, in the style of sign-in and "Name this till" and
wider. Its head has the mark, "Set up <business>", "2 of 5" and a dot for each step. Its foot has one main
key that says what it will do ("Continue", "Save and continue") and, while the step is not done, a quiet
**Skip for now**. Back goes to the step before; on the first step of a first run it does nothing, and on
a summary opened later it leaves the set-up. Steps change with the till's own motion (`Motion`), and only
in answer to a tap.

**Done.** A step is done when its work exists, whoever did it and wherever:

| Step | Done when |
| --- | --- |
| Menu, Products | the business has an item |
| Tables | this store has a table |
| Printer | this store has a printer (a kitchen screen is not one) |
| Business details | the business has an address or a phone |
| Staff and PINs | someone has a PIN |

A step that is done opens on what is there. The first run starts at the first step that is not done, or
at the summary when all are.

**Saving.** Every save is asked online and waited for, as `item.save` is. The row comes back by a pull that
`ask` starts and does not wait for, so each step shows what it has just saved from its own state until the
pull lands. A save that cannot reach the server says so in the till's usual words and keeps what was typed.

### Menu (a shop: Products)

- Categories down the left: colour, name, how many items. **New category** takes a name; its colour is the
  next of the twelve swatches not in use.
- The chosen category's items on the right, and under them one line: name, price, **Add**. A shop's line
  has a barcode too, typed or scanned. Add returns to the name, so a menu is typed down the page.
- With no category yet, the line gives way to "Start with a category".
- Tapping an item opens the till's own item sheet; tapping a category's name, its category sheet.
- Under it, where the rest is: a shop is told of Import products in the back office; a restaurant, that
  add-ons and tax are set there.

### Tables (restaurants)

- One line a room: its name, how many tables, seats at each (4 unless changed). **Add a room** gives
  another line. The first line says Main.
- The tablet names the tables with numbers that run on across rooms, and after the highest number among
  the tables the store has: Main 1 to 12, Terrace 13 to 18. A table's name is its own in the whole store
  (`uq_tables_store_name`).
- It lays a room of n tables out in rows on the 100 by 60 plan. Columns: the square root of n × 100 / 60,
  rounded up. Rows: n / columns, rounded up. Each table is square, in the middle of its cell, its side 60%
  of the cell's shorter side, rounded down and kept between 4 and 12 units. Up to 60 tables a room; the
  form says so above that.
- A room the store already has cannot be added again: its tables are changed in the back office.
- A store that has tables already shows its rooms with their counts, and still offers Add a room.

### Printer

- The step sets up one printer: the one the receipts come out of. In a store with no printer it is the
  form below. In a store that has printers it lists them, each with **Test** and **Change**, and says that
  more printers and what prints where are in the back office.
- The form: a name ("Receipt"), how it is connected, and its paper, 80 mm or 58 mm.
  - **Network**: its address.
  - **USB**: plugged into the tablet. The step says whether the tablet sees a printer.
  - **Bluetooth**: picked from the devices paired with the tablet, after the tablet has allowed EasyPay to
    use Bluetooth (the Printers page's prompt). A key opens the tablet's Bluetooth settings, for pairing.
- A restaurant has a switch, **Kitchen orders print on it too** (`onePrinter`), on unless switched off.
- **Print a test page** prints from what is typed, before anything is saved. If the printer does not
  answer, the step says so, in the Printers page's words. If it answers, the step asks "Did it print?".
  **Yes, save it** saves the printer; **No** returns to the form with what to check for that connection.
- A test of a printer that is not saved leaves nothing in the Printers page's list of failed prints.

### Business details

- Name, address, phone, BRN and VAT number, filled in with what the business has.
- Beside the form, the top of a receipt as it will print, redrawn as the boxes are typed in.

### Staff and PINs

- Everyone the business has: name, role, "PIN set" or "No PIN". Tapping one opens a keypad for a
  four-digit PIN; the digits show as they are typed, as in the back office.
- **Add someone**: a name, a role and a PIN. The roles are the business's own, except Owner.
- The first PIN goes to someone who may open the day and set up the till (`shift.open_close` and
  `settings.device`): the owner, or a manager. Until one of them has a PIN, nobody else can be given one
  and nobody can be added. A till where only a waiter has a PIN could not open its day, and one where
  only a cashier has could open it and approve nothing.
- The step says what a PIN changes: each person clocks in and signs in with their own, and the till knows
  who rang up what. Without PINs the register opens with one tap.
- Only the owner may add staff or set a PIN (`employees.edit`), as in the back office. Under a manager's
  login the server refuses the first save; the step then says to ask the owner, and where in the back
  office it is done. When someone approved the set-up with a PIN, the tablet knows their rights and says
  so before anything is typed.

### The summary

- "<business> is ready to sell", and a line for each step: ticked, with what is there ("43 items in 8
  categories", "18 tables in 2 rooms"), or open, with what its absence means ("No printer: nothing prints
  and the cash drawer stays shut") and **Do it now**.
- One line names what the tablet does not set: taxes, discounts, add-ons, the receipt's logo, more
  printers and the plan's exact layout, in the back office, with its address.
- While the set-up is open its key is **Open the till**: it sends `setup.finish`, hides the start screen's
  key on this tablet at once, and goes to the start screen. It does not wait for the server:
  `setup.finish` is queued like a sale.
- Once the set-up is done, or for a client that was never shown it, the key is **Back to the till** and
  sends nothing.

## 3. Server, migration 0089

Six ops. Each is refused with `forbidden` unless the person, or the one named in `approved_by`, holds the
right the back office asks for the same change (`may()`).

- **`tables.add {store_id, area, tables: [{id, name, seats, shape, x, y, w, h}], approved_by?}`**. Adds
  tables and changes none. 1 to 60 tables; the store never above 300 (`too-many`), the back office's limit.
  The bounds are the table's own checks (0048); outside them, `bad-payload`. A table whose id is already
  one of this store's is skipped, so sending the same room twice adds nothing. If any is left to add: the
  room must be new to the store (`room-exists`) and no name may be in use there (`name-taken`). Right:
  `settings.device`. Refusals: `unknown-store`, `too-many`, `room-exists`, `name-taken`, `conflict` (an id
  that is another client's), `forbidden`, `bad-payload`.
- **`printer.save {id, store_id, name, kind, address, paper_mm, one_printer?, approved_by?}`**. Makes a
  printer, or changes the name, connection, address and paper of one. `kind` is `network`, `usb` or
  `bluetooth`. An id that is a kitchen screen's, a removed printer's, or a printer of another store of the
  business, is `bad-printer`: a kitchen screen is the back office's. The address follows the back office's rules: a network printer needs an IP
  address, a Bluetooth one a name or an address (0088), a USB one has none (`bad-address`). The first
  printer of a store prints its receipts, as `saves.addPrinter` decides; feed and cut take the back
  office's defaults. `one_printer`, when sent, is written to `pos_settings.onePrinter`. Right:
  `settings.device`. Refusals: `name-required`, `bad-address`, `unknown-store`, `bad-printer`, `conflict`,
  `forbidden`, `bad-payload`.
- **`company.save {name, address, phone, brn, vat, approved_by?}`**. Writes what the back office's Company
  details writes: `tenants.name`, `brn` and `vat_number`, and `pos_settings.company`. The same lengths (80,
  240, 40, 30, 30). Right: `settings.device`. Refusals: `name-required`, `forbidden`, `bad-payload`.
- **`staff.save {id, name, role_id, pin_hash, approved_by?}`**. Adds a member of staff with no login, at
  every store of the business, as the back office's Staff page does. The role must be the business's
  (`bad-role`). An id that is already this business's member of staff changes nothing. Right:
  `employees.edit`. Refusals: `name-required`, `bad-role`, `bad-pin`, `conflict`, `forbidden`,
  `bad-payload`.
- **`staff.set_pin {employee_id, pin_hash, approved_by?}`**. Sets the PIN of a member of staff of this
  business. Right: `employees.edit`. Refusals: `unknown-staff`, `bad-pin`, `forbidden`, `bad-payload`.
- **`setup.finish {approved_by?}`**. Writes `pos_settings.setup = "done"`. Done already is done. Right:
  `settings.device`. Refusal: `forbidden`.

**The PIN.** The tablet hashes it as the back office does (`lib/pin.ts`) and sends the hash; the PIN is
never sent. The two ops take only a hash of that exact shape, `pbkdf2-sha256$20000$`, a 16-byte salt and a
32-byte hash in base64 (`bad-pin`).

**Other changes in 0089.**

- `platform.create_tenant` writes `setup: "open"` beside the plan.
- `platform.set_tenant_details` also writes the name, BRN and VAT number into `pos_settings.company`, and
  leaves the address and phone there as they are. Once, for every client, a name, BRN or VAT number that
  `tenants` holds and `pos_settings.company` lacks is copied in. Nothing a client saved in the back office
  is overwritten. Without this the tablet's form would open with empty BRN and VAT boxes and wipe what
  `/admin` holds when it saved. It also means a BRN or VAT number typed in `/admin` prints on that client's
  receipts from its next sync.
- `sync_push`, `create_tenant` and `set_tenant_details` are regenerated from dev's live definitions
  (`sync_push` was last rewritten by 0087), with the ops and their codes added.
- 0089 is taken only after checking that no other session has taken it.

**The demo script.** `db/scripts/seed-demo-client.cjs` marks the set-up done once it has filled a client,
so a demo client opens on the start screen in front of a customer.

## 4. The till, 0.7.0 (versionCode 11)

- `feature/setup/`: the frame and the summary, one file a step, and its view model.
- `core/data/`: what can be decided without a screen, each with unit tests: which steps a business has,
  which are done and which comes first (`SetupSteps`); the numbering and the grid (`TableLayout`); what the
  printer, staff and company forms hold, and the server's refusals in words, as `ItemForm` does, with
  `unknown-op` among them ("The server has to be updated before...").
- `ServiceRepository`: `addTables`, `savePrinter`, `saveCompany`, `addStaff`, `setPin` through `ask`, each
  carrying an approver as `saveItem` does; `finishSetup` through the outbox.
- `PinHash.make`: a random 16-byte salt, 20,000 rounds, 32 bytes. Its test holds a hash that `lib/pin.ts`
  made, so the two cannot drift.
- `Printing`: a test page to a printer that is not stored, from what was typed.
- `PosSettings.setupOpen`; `SessionStore`: that this tablet has closed the set-up.
- `AppNav`: the waiting screen and the set-up after `DEVICE`; the set-up from the start screen and from
  Settings. Its rule that a screen brought back with nobody signed in returns to the start screen stays as
  it is and covers the set-up.
- `StartScreen`: **Finish setting up**. `SettingsScreen`: the **Set-up** page.
- `AuthScreens`: the demo-menu link goes, with `StoreDeviceAction.SeedDemo` and `ApiClient.seedDemo`. The
  card's pieces (`SetupCard`, `SetupField`, `MainKey`, `QuietLink`) move to a file both packages use. The
  API's `/seed-demo` stays: tills up to 0.6.3 still have the link.
- Help: "Setting the till up" in `HELP` and in `SHOP_HELP`.
- Room does not change: tables, printers, staff and settings are there already.
- The words are English, as on sign-in and "Name this till".

## 5. Tests

- `db/tests/till-setup.test.cjs`, written first, in one transaction rolled back. For each op: accepted;
  refused without the right and accepted with an approver; another client's rows untouched; a pull hands
  the rows to a till. And: two rooms numbered on; a room sent twice; a name in use; a room that exists; the
  300th table; the first printer made the receipt printer and the second not; a kitchen screen refused; a
  Bluetooth printer with no address; a hash of the wrong shape; a manager refused `staff.save`; a client
  made by `create_tenant_of_type` starting open and one from before 0089 without the key;
  `set_tenant_details` reaching `pos_settings.company` with the address kept; the one-off copy leaving a
  saved BRN alone.
- `db/tests/seed-demo-client.test.cjs`: the client ends with its set-up done.
- Unit tests written first for `SetupSteps`, `TableLayout`, the forms and `PinHash.make`.
- The whole unit suite and `assembleDebug`.
- Seen on `easypay_claude_till` as the made-up restaurant and the made-up shop, never on the owner's
  emulator. That build has no server: the screens, their checks and the test page's refusal are seen, not
  a save going through. Not seen by Claude: the flow after a real sign-in, which needs a login.

## 6. Release

Two plans: the server (0089, its suite, the demo script), then the till. Built and committed on
`restopos`; 0089 applied to dev only. Production takes it with the tag that carries till 0.7.0, after
0088; the release run applies the migrations in order. No tag is pushed before the owner says to go live.

## For the build plans

- The wait after "Name this till" relies on `setLastPull` being written only when a whole paged pull has
  succeeded. It is (`Sync.kt`, read 2026-10-09).
- `create_tenant` now writes `setup` into `pos_settings`. Once 0089 is on dev, every dev-safe suite that
  makes a client is run, not the new one alone: one that compares that row exactly would break.
- What an added scanner reads goes only to the screens that take scans (0.6.2). The Products step is made
  one of them, or its barcode box stays empty when a shop with an added scanner opens the set-up from
  Settings.
- The debug build's made-up business has no `setup` key and skips sign-in and "Name this till". Its steps
  are reached from Settings. The wait and what follows it need a debug command, as the update's download
  did (`DEMO_UPDATE`), or are listed as not seen.

## Left out

- A sample menu to start from.
- A second printer for the kitchen, and which category prints where, on the tablet.
- Drawing or moving tables on the tablet.
- A choice of language at the start.
- Finding network printers by searching the Wi-Fi.
- `/admin` showing whether a client has finished its set-up.
- Adding a printer from the tablet's Printers page (the op allows it; no screen asks for it).
