# Customer display: build plan

> For one session, task by task, with no subagent per task (the owner is cost-sensitive). Steps are checkboxes. The design is `docs/superpowers/specs/2026-10-21-customer-display-design.md`; read it first.

**Goal:** a second tablet running the same APK shows the customer the order being rung up on its till (lines, discounts, VAT, total, paid and change) and the business's name, logo and message between sales, over the shop's own Wi-Fi, on every plan.

**Architecture:** a display is a printer row of kind `display` facing one till (`printers.device_id`, migration 0129, Room 33). The till works out a picture of its open order from Room (`DisplayFeed`) and sends the whole picture, signed with the display's pairing code, to each display facing it (`DisplayLink`, port 9311), as the kitchen screen's link does. The display tablet listens (`ScreenServer`), keeps the latest picture (`DisplayBook`) and draws it (`feature/display`). Every place that took "not a kitchen screen" for "a printer" goes through one test, `Routing.silent` / `silent()` in `web/lib/printers.ts`.

**Stack:** Kotlin, Compose, Room, Hilt, kotlinx.serialization, JUnit 4 on the JVM; Postgres (Neon) migrations in `db/migrations`, suites in `db/tests` (`node db/tests/<name>.test.cjs`); Next.js back office in `web/`.

**Where:** worktree `C:\Projects\RestoPOS\.claude\worktrees\customer-display`, branch `claude/customer-display`. The loyalty session works in the main folder at the same time (0128, Room 32). Rebase on `restopos` before each fast-forward. Gradle with `--priority low --max-workers 2`, then `gradlew --stop` before an emulator starts. Never a `db/tests` suite while another session runs one.

Unit tests: `cd android && ./gradlew --priority low --max-workers 2 :app:testDebugUnitTest --tests 'com.restopos.core.display.*'` (all: drop `--tests`).

---

## Files

| File | What it is |
|---|---|
| `core/display/Picture.kt` (new) | `Picture`, `PicLine`, `PicSum`: what a display shows, serialisable |
| `core/display/DisplayWire.kt` (new) | request/reply, signed framing (reuses `Wire.sign`), port 9311, logo hash |
| `core/display/Pictures.kt` (new) | plain rules: a sale's picture from its lines and totals, the paid picture, idle |
| `core/display/DisplayBook.kt` (new) | the display tablet's rules: checks, keeps the latest, idle after 60 s, the logo |
| `core/display/DisplayFeed.kt` (new) | the till: the picture of now, from Room; Pay's `paid()` |
| `core/display/DisplayLink.kt` (new) | the till: sends to each display facing it; status and Test |
| `feature/display/DisplayMode.kt` (new) | the display tablet's view model and screens |
| `core/kitchen/Wire.kt` | `address(text, port)` takes the port |
| `core/data/Routing.kt` | `DISPLAY`, `silent()`, `displays()`; `paper` and `line` use them |
| `core/sync/Sync.kt` (SessionStore) | mode `display`; flows of the active ticket and pending discount |
| `app/AppNav.kt`, `feature/auth/AuthScreens.kt` | the route and "Set up as a customer display" |
| `core/database/Ops.kt`, `TillDatabase.kt`, `Migrations.kt`, `core/sync/PullApplier.kt` | Room 33: `device_id`, `message` |
| `core/data/PrinterForm.kt`, `core/data/Service.kt`, `core/data/LocalAnswers.kt` | a display saved from a tablet |
| `feature/settings/SettingsScreen.kt`, `BusinessPages.kt` | the displays under Printers; Add a customer display (alone) |
| `feature/pay/Pay.kt` | one call: `display.paid(total, change)` |
| `feature/menu/MenuStock.kt`, `feature/setup/SetupViewModel.kt` | `silent()` in place of `!= "screen"` |
| `db/migrations/0129_customer_displays.sql` (new), `db/tests/customer-display.test.cjs` (new) | the server |
| `web/lib/printers.ts`, `web/lib/saves.ts`, `web/app/backoffice/printers/page.tsx`, categories page, importer | the back office |

---

### Task 1: the picture and the wire

- [ ] Write `DisplayWireTest` (JVM): a request signed with the code decodes; with another code, or changed after signing, it does not (null); a reply round-trips; `hash(null)` is `""` and a data URL's hash is the same each time and differs for another; `address("10.0.2.5")` is port 9311 and `address("10.0.2.5:9400")` 9400; a request from a newer build with a key this build does not know still decodes.
- [ ] Run it: fails (no classes).
- [ ] Write `Picture.kt`:

```kotlin
@Serializable data class PicLine(val qty: String, val name: String, val detail: String = "", val amount: Long)
@Serializable data class PicSum(val label: String, val amount: Long)
@Serializable data class Picture(
    val state: String = IDLE, // idle | sale | paid
    val title: String = "", val lines: List<PicLine> = emptyList(), val sums: List<PicSum> = emptyList(),
    val total: Long = 0, val paid: Long = 0, val left: Long = 0, val change: Long = 0,
    val lang: String = "en", val decimals: Int = 2, val business: String = "", val message: String = "",
) { companion object { const val IDLE = "idle"; const val SALE = "sale"; const val PAID = "paid" } }
```

- [ ] Write `DisplayWire.kt`: `DisplayRequest(v, till, tillName, display, picture, logo: String? = null, logoHash = "", now = 0)`, `DisplayReply(ok, error = null, v, build = 0, logoHash = "")`; `VERSION = 1`, `PORT = 9311`, `REFUSED`, `OTHER_VERSION`; `encode(req, code)`, `decode(first, second, code)`, `encode(reply)`, `decodeReply(line)`, `hash(logo)` (SHA-256 hex, first 16), `address(text) = Wire.address(text, PORT)`. Json with `ignoreUnknownKeys`, `encodeDefaults`. In `Wire.kt`, `address(text, port = PORT)`.
- [ ] Run: passes, and `WireTest` still passes. Commit "till: the customer display's picture and its wire".

### Task 2: a sale as a picture (`Pictures`)

- [ ] Write `PicturesTest`: two burgers with an egg (amount 24000) and a cola, no discount, VAT included 15% → `state=sale`, lines in order with "2"/"1", detail "Egg", sums Subtotal and "VAT included" (the included figure), total; a 10% discount named "Staff" → sum "Staff" negative; service 10% → "Service 10%"; VAT added → "VAT"; rounding non-zero → "Rounding"; with `paidSoFar` 10000 → `paid` 10000 and `left` the total still due; a line of 0.5 kg → qty "0.5"; `paid(total = 31500, change = 18500)` → `state=paid`, `paid = 50000`; `idleOf(p)` keeps business, message, lang, decimals and drops the rest; an empty list of lines → idle.
- [ ] Run: fails.
- [ ] Write `Pictures` (object): `sale(title, lines: List<PicLine>, totals: Calc.Totals, vatIncluded: Long, discountName: String?, servicePct: Int, paidSoFar: Long, words: Words): Picture`, `paid(total, change)`, `idleOf(p)`, `qty(qtyThousandths)`. `Words` holds the till's words in its language (`subtotal`, `vat`, `vatIncluded`, `service`, `rounding`), filled from `L.t` by the feed so the rules stay plain. The VAT included figure is passed in: `Calc.Totals.tax` holds both kinds; the feed works out the included part with `Calc.totals` over the included taxes only (Task 7). Calc is not changed.
- [ ] Run: passes. Commit "till: an order as the customer display's picture".

### Task 3: the display's book (`DisplayBook`)

- [ ] Write `DisplayBookTest` (as `ScreenBookTest`: fixed code, a clock): a wrong code is refused and nothing is kept; another version → `OTHER_VERSION` and the build; a picture is kept and `shown(now)` is it; 60 s with nothing → `shown` is `Pictures.idleOf` of the last; a newer picture from another till replaces it (latest wins); a logo is kept with its hash and the reply carries the hash; a request without a logo keeps the one held; `logo = ""` clears it; nothing ever heard → `shown` null (the waiting page).
- [ ] Run: fails.
- [ ] Write `DisplayBook(code: suspend () -> String, build: Int, clock: () -> Long, keepLogo: suspend (String?, String) -> Unit)` with `held: StateFlow<Held?>`, `logo: StateFlow<String?>`, `answer(first, second): String`, `shown(now): Picture?`, `restore(logo, hash)` (from the file at start), `SILENT_MS = 60_000`.
- [ ] Run: passes. Commit "till: the customer display tablet's rules".

### Task 4: "prints nothing" on the till

- [ ] Add to `RoutingTest`: a `display` row is in no `paper()` list, in no `tickets()` result, never `single()` even if marked receipt, and `line()` is `address:9311`; `displays(all, device)` keeps kind display, switched on, not removed, facing that device; `silent("screen")`, `silent("display")` true, the paper kinds false.
- [ ] Run: fails.
- [ ] In `Routing.kt`: `const val DISPLAY = "display"`, `fun silent(kind: String) = kind == SCREEN || kind == DISPLAY`, `paper()` filters `!silent(it.kind)`, `line()` takes port 9311 for a display, `displays(all, device)`. In `MenuStock.kt:133` and `SetupViewModel.kt:148`, `!Routing.silent(it.kind)` in place of `!= "screen"`. Grep `"screen"` in `android/` and settle each hit (LocalAnswers waits for Task 8).
- [ ] Run all unit tests. Commit "till: a customer display prints nothing".

### Task 5: the display tablet

- [ ] `SessionStore`: `isDisplay()`, `setDisplay(code)` (mode `display`, the pair code kept if there), `leaveDisplay()`; `activeTicketFlow`, `pendingDiscountFlow` (`distinctUntilChanged`).
- [ ] `feature/display/DisplayMode.kt`: `DisplayModeViewModel` (as `KitchenModeViewModel`: `ScreenServer(DisplayWire.PORT) { a, b -> book.answer(a, b) }`, restart when not listening, address every 5 s, a clock each second for `shown`, the logo in `filesDir/display_logo` with its hash, light switch, new code, become a till, the update key as the kitchen's: copy its four functions, they are short); `DisplayModeScreen`: waiting page (address, code, "In the back office, under Printers, add a customer display…"), idle (logo, name, message), sale (lines left / sums right on a wide screen, stacked on a tall one; newest line kept in view), paid (change large, "Thank you"); words through `L.t` with `L.lang` set from the picture; a gear opens the settings sheet; Back does nothing.
- [ ] `AppNav`: `Routes.DISPLAY`, start there when `isDisplay()`; `AuthScreen` gets `onDisplay`, a third card "Set up as a customer display" ("For a tablet that faces the customer: it shows the sale as it is rung up. It needs no login."); debug builds use code `DSPLY234`.
- [ ] Build the debug APK (`assembleDebug`, low priority). Commit "till: a tablet set up as a customer display".

### Task 6: Room 33 (after loyalty's Room 32 is on `restopos`)

- [ ] Rebase on `restopos`. If Room 32 is not committed yet, ask the loyalty session once (SendMessage) and do Task 7 meanwhile.
- [ ] `PrinterEntity`: `device_id: String? = null`, `message: String? = null`. `TillDatabase` version 33, `V32_V33` (two `ALTER TABLE printers ADD COLUMN … TEXT`), registered after `V31_V32`; schema exported if the project exports. `PullApplier` maps `device_id` and `message`. Backup/restore: check it copies whole tables (no change if so).
- [ ] Unit tests (the migration test, if there is one for 31→32, gets 32→33). Commit "till: Room 33, a printer row's till and message".

### Task 7: the server (0129) and its suite

- [ ] Read the live `push_printer_save` (0127 is the last to write it) and `printers_screen_check`; read `db/tests/kitchen-screens.test.cjs` for the suite's shape.
- [ ] Write `db/tests/customer-display.test.cjs` (one transaction, rolled back): a display row inserted with address, code and a till of its store is kept; without code, without address, as receipt, or with a till of another store is refused; on a Standard and on an offline plan it is allowed (no plan trigger); `push_printer_save` with `kind: display` adds it, never as the receipt printer, and a later network printer of that store still becomes the receipt printer; an edit of a display by `push_printer_save` keeps it a display; `kind: screen` is still refused there; a display's `message` longer than 120 characters is cut.
- [ ] Write `0129_customer_displays.sql`: kind check with `display`; `device_id uuid`, `message text`; `printers_display_check` (`kind <> 'display' or (not is_receipt and pair_code non-blank and address non-blank and device_id is not null)`); a trigger that checks `device_id` is a `pos_devices` row of the same tenant and store, not removed, on insert or when it changes; `push_printer_save` rebuilt from 0127 with `display` (code tidied as `PairCode.tidy`, `device_id`, `message` cut to 120) and `kind <> 'screen'` → `kind not in ('screen', 'display')`. Header names 0127 as the source.
- [ ] Apply to dev from the worktree (`.env.local` copied in, `web/node_modules` linked; both removed after), run the suite once. Commit "server: customer displays (0129)".

### Task 8: a display added on an offline tablet

- [ ] `LocalAnswersTest` (or its file's tests): `printer.save` with `kind: display`, address, code, device and message is kept as a display, never the receipt printer; without a code it is refused `bad-address`/`bad-code`; editing a kitchen screen is still refused.
- [ ] `PrinterForm`: `DISPLAY`, read a display (name, address as a network printer's, code through `PairCode.tidy`, message ≤ 120); `refused` words for `bad-code`. `Service.savePrinter` puts `pair_code`, `device_id` (this tablet), `message` for a display. `LocalAnswers.printerSave` takes `display` as 0129 does, `!= "screen"` → `!Routing.silent`.
- [ ] `BusinessPages.kt`: `AddDisplayKey` (name, address, code, two message lines; "It faces this till."); `SettingsScreen.PrintersPage` shows it when `Journey.alone`, for restaurants and shops.
- [ ] Unit tests. Commit "till: a customer display added on an offline tablet".

### Task 9: the till sends (`DisplayFeed`, `DisplayLink`)

- [ ] `ServiceRepository.vatIncluded(lines, servicePct, discount)`: `Calc.totalsRounded` over the unpaid lines with only their included taxes, its `tax`. Test beside `dueOf`'s tests if there are any, else in `PicturesTest` through `Calc` directly.
- [ ] `DisplayFeed` (singleton): `suspend fun now(at)` — the paid picture while it holds (20 s) and no line is on a new order; else the active ticket's lines (`service.describe`, voided and deleted left out) → `Pictures.sale` with title as the order screen makes it, totals `service.dueOf`, `vatIncluded`, the pending discount's name, `paidForTicket`; else idle; `business` from the settings' company name or `session.businessName()`, `lang = L.lang`, `decimals`. `changes: Flow<Unit>` = active ticket, its lines (`flatMapLatest`), pending discount, paid. `paid(total, change)`.
- [ ] `DisplayLink` (singleton, started where `ScreenLink` is in `ShellViewModel`): loop — the displays (`Routing.displays(printing.usableAll(), deviceId)`; add `Printing.displays()`), the picture `feed.now()`, each display sent `picture.copy(message = row.message ?: "")` side by side (`ScreenClient.exchange` with 1.5 s connect, 4 s read), the logo only when the reply's hash differs from `DisplayWire.hash(logo)`; then wait for `changes` or 5 s (sale/paid) / 30 s (idle). `status(): StateFlow<Map<String, DisplayStatus>>` kept in memory; `test(id)` in words.
- [ ] `Pay.kt`: inject `DisplayFeed`; where the normal sale's `PayDone` is made, `display.paid(earlierTotal + receipt.total, change)`.
- [ ] `SettingsScreen.PrintersPage`: "Customer displays" (each: name, address, Answering/Not answering, Test), for restaurants and shops; Help entry "A customer display" (restaurants and shops, not premium).
- [ ] All unit tests, debug build. Commit "till: the till shows its sale on its customer displays".

### Task 10: the back office

- [ ] `web/lib/printers.ts`: kind union with `"display"`, `export const silent = (k) => k === "screen" || k === "display"`; `PrinterRow` gets `device_id`, `message`.
- [ ] `web/lib/saves.ts`: `savePrinter` writes `pair_code`, `device_id`, `message` for a display (null for the others); the add path as `addScreen` does.
- [ ] `printers/page.tsx`: `rows = all.filter(p => !silent(p.kind))`; `displays = all.filter(kind === "display")`; section "Customer displays" after Kitchen screens, on every plan, restaurants and shops: Add (name, address, code, till from the store's `pos_devices`, message two lines), each with Save, Switch off, Remove; a display facing a removed till says so; two displays at one address warned; the note on which EasyPay every till needs. Categories page and importer: `silent()` where they test `screen`.
- [ ] Extend `db/tests/backoffice-saves.test.cjs` (or the suite that covers `savePrinter`) with a display saved and edited; run it once. `cd web && npx tsc --noEmit`. Commit "back office: customer displays under Printers".

### Task 11: two emulators, then hand over

- [ ] Rebase on `restopos`, all unit tests, `assembleDebug`, `gradlew --stop`. Free memory checked (two emulators need about 3.6 GB).
- [ ] Read the emulator note whole; `git log -5` for other sessions' work; say before each step. Start an AVD of mine with its window as the display ("Set up as a customer display"), and another with its window as the till (`DEMO_SHOP --es plan offline`). On the till: Settings, Printers, Add a customer display (the display's address, `DSPLY234`, a message). Ring up three items, a discount, Pay cash with change; screenshots of the display at each step; switch the display's app off and on mid-sale; then the made-up restaurant (`--es type restaurant --es plan offline`): a takeaway with an add-on, paid. Leave both as the note asks and write what was left in the note.
- [ ] Note in the shared notes folder and the project memory; fast-forward `restopos`; not pushed, no tag.
