# Customer display: a second tablet that faces the customer

Date: 2026-10-21. Status: design approved by the owner in its parts (below); this document waits for their read.

## 1. What was asked, and what the owner chose

The owner asked how EasyPay compares with Loyverse. Loyverse gives away a Customer Display app: the order, discounts, taxes, total and change, over the shop's Wi-Fi, working offline. EasyPay has none, and it costs nothing to run, so it was put near the top of what is missing.

The owner's answers (2026-10-21, each a tap on the options put to them):

| Question | Answer |
|---|---|
| Which plans | **Every plan, free**, the offline edition included |
| Which businesses | **Restaurants and shops** |
| Product pictures | **None: words only** |
| Between sales | **Name, logo and a typed message** |
| Where it is paired | **In the back office, under Printers, like kitchen screens** |
| An offline-edition client (no back office of its own) | **Also on the tablet**, in Settings, Printers, as it adds its printers |

## 2. What the customer sees

The display follows the order open on its till, whatever screen opened it: a quick sale, a takeaway, a shop's sale, or a table's bill brought up at the counter.

- **Between sales** (the idle screen): the business's logo (the one on its receipts) and name, and the display's message: up to two lines typed where the display is set up ("Ask about our lunch deal").
- **During a sale**: the order's title, small ("Takeaway A-12", "Table 4", "Sale"); its lines, each with its quantity, name, add-ons beneath, and amount; the newest line at the bottom, the list scrolled so it is always in view; then subtotal, each discount by its name, service, VAT ("VAT included" when the prices hold it, "VAT" when it is added), rounding when there is any; and the total, large. When part of the bill is already paid (a split bill), "Paid" and "Left to pay" under the total.
- **After Pay**: the total, what was paid, and the change in large type, with "Thank you". It stays 20 seconds, or until an item is rung up on the next sale, then the idle screen.
- **When it hears nothing from its till for 60 seconds**: the idle screen (a till switched off mid-sale must not leave an old order in front of the next customer).

Refunds, deposits, account payments and exchanges show nothing of their own in this first version: the display stays on the idle screen or on the sale's lines.

Words follow the till's language (English, French, Kreol), sent with each picture. The display is light by default, with a switch for dark on the display itself. A tablet held upright or on its side gets the same screen laid out for its shape (on its side: lines on the left, totals on the right; upright: totals under the lines).

## 3. Setting it up

**The display tablet.** EasyPay's first screen offers "Set up as a customer display" beside "Set up as a kitchen screen". It needs no login and never talks to our server except to ask whether a newer EasyPay exists (as the kitchen screen does). Until a till has spoken to it, it shows its address on the Wi-Fi and an eight-character pairing code (the kitchen screen's `PairCode`), and how to add it. Its settings (a gear) hold: the address and code, Make a new code, Light or dark, the EasyPay version and update, and "Use as a till instead".

**In the back office, Printers** gets a section "Customer displays" under "Kitchen screens", for restaurants and shops, on every plan: Add a customer display with its name ("Counter"), its address, its pairing code, the till it faces (a choice of the store's tills; the only one picked already), and its message (two lines). Each display has Save, Switch off and Remove, as a kitchen screen does. The page says every till needs the build that knows displays (section 7).

**On an offline-edition tablet**, Settings, Printers gets "Add a customer display" beside "Add a printer", for restaurants and shops: name, address, code, message. It faces this tablet. It is saved the way a printer added there is (`printer.save`, answered on the tablet by `LocalAnswers`), so if the business later goes to the cloud, the display goes up with its queue. On a cloud tablet the key is not shown: displays are added in the back office (one condition to change if the owner wants it everywhere).

The till's Settings, Printers lists the displays that face it, each with Answering / Not answering and Test, as it lists kitchen screens.

## 4. The data (server migration 0130)

(First written as 0129; renumbered on 2026-10-21 because the Sunwave Laundry work took 0129, `0129_sold_by.sql`, on dev first.)

A display is a printer row, as a kitchen screen is (0086), so it is set up, synced, switched off and removed the way they are:

- `printers.kind` takes `'display'` beside `network`, `usb`, `bluetooth`, `screen`.
- `printers.device_id uuid null`: the till it faces, required for a display (null for every other kind). Checked to be a till of the same tenant and store wherever a row is written. A display whose till was removed shows on the Printers page as facing a removed till, to be given another.
- `printers.message text null`: the idle screen's two lines, at most 120 characters, one line break.
- A display has an address and a pairing code, is never the receipt printer, and is never ticked for a category: a check like `printers_screen_check`.
- No plan trigger: displays are free on every plan.
- `push_printer_save` (rebuilt from its live definition in 0127) also takes `kind: 'display'` with `pair_code`, `device_id` and `message`. Its two `kind <> 'screen'` tests become "prints nothing" (`screen` or `display`): a display is not a store's first printer, so it never takes the receipts.
- A pull hands out whole rows: `sync_pull` needs no change.

**Prints nothing.** Everywhere a kind is tested today as "not a screen, so a printer", it becomes one helper, "this kind prints nothing" (`screen`, `display`), on the till (`Routing.silent`) and in the back office (`web/lib/printers.ts`). The places, read on 2026-10-21: `Routing.paper` and `Routing.line`; `MenuStock.kt`; `SetupViewModel.kt`; `LocalAnswers.printerSave`; `push_printer_save`; `printers/page.tsx` (step 2's grid and the same-printer check); `printerWarnings`; `saves.savePrinter`; the categories page and the import (which name printers). The plan greps `screen` across `android/`, `web/` and the live functions and settles each hit.

**On the till (Room 33):** `PrinterEntity` gets `device_id` and `message`, null by default. Room 32 is the loyalty work's; this goes after it.

## 5. The till's side

- **`DisplayFeed`** (a singleton beside `ScreenLink`): works out the picture from the till's own database: the active order (`SessionStore` active ticket, as a flow), its lines (`service.describe`), its totals as the order screen works them out (`service.dueOf` with the pending discount and service), what is paid on it (`paidForTicket`). VAT is split into included and added from the lines' taxes (Calc's `Totals.tax` holds both together; a `taxIncluded` figure is added beside it, defaulting to 0). Pay tells it when a sale is done (total, paid, change, from Pay's done state), and the picture becomes "paid" for 20 seconds. Nothing on the order or retail screens changes.
- **`DisplayLink`**: the displays this till shows to (kind `display`, switched on, not removed, `device_id` this tablet). It sends each the whole picture: at once when it changes, every 5 seconds while a sale or a "paid" is up, every 30 seconds while idle. A display that was off has the picture again within seconds of coming back. Several displays get the same picture side by side; one that is off holds up no other.
- **The message** carries the whole picture, never a change, so a lost or repeated one does no harm. The logo (a data URL from the settings, the receipt's) is sent only when the display says it holds another one (the display answers with the hash of the logo it has).

## 6. The display's side

- Its own message, `DisplayWire`, with its own version, on its own port **9311** (the kitchen screen's is 9310), framed and signed as the kitchen's is: one line of JSON, then its HMAC with the pairing code (`Wire.sign`). Unsigned or wrongly signed: refused, with nothing said about why.
- `ScreenServer` and `ScreenClient` are used as they are, with the port given.
- **`DisplayBook`** (plain Kotlin, tested on the JVM): checks the signature, keeps the latest picture and when it came, the logo and its hash, and says what is on screen now (the picture; "paid" kept 20 seconds; idle after 60 seconds without a word). With two tills sending to one display (two rows given the same address by mistake), it shows the latest picture it was sent; the back office warns when two displays share an address.
- **`DisplayMode`** (`feature/display`): the screen, entered at launch when the tablet's `MODE` is `display` (beside `kitchen`), with Back doing nothing, as on a kitchen screen. What it keeps: the code and mode in `SessionStore`, the light switch, the logo (a small file). It keeps no sales.

## 7. Older tills, and the release

A till built before this reads a `display` row as a network printer (`Routing.line` sends any kind it does not know to port 9100). It routes nothing to it (a display is never the receipt printer and never ticked for a category), but lists it under Printers, checks it and shows it as not answering. So, as with the kitchen screen:

- The back office page says which EasyPay every till needs before a display is added.
- The release that carries 0130 raises `MIN_TILL_VERSION` to its build. That is a release step for the owner; this work tags nothing and pushes nothing.

## 8. My decisions the owner has not confirmed

- A display faces one till, chosen in the back office (the store's only till picked already); added on a tablet, the tablet itself.
- 20 seconds for the change, 60 seconds of silence to idle, 5 s and 30 s between pictures.
- Light by default; the message is two lines of 60 characters.
- The key on a tablet is shown only on an offline-edition tablet.
- Several displays may face one till; all show the same.
- Not built now: pictures, promotions or a slideshow on the idle screen, the customer's name or loyalty points, a QR code to pay, a display wired to the till by cable or HDMI.

## 9. Testing, and what will not be seen

- **Unit tests (JVM):** the picture from an order (lines, add-ons, discounts, service, VAT included and added, rounding, split), the paid picture and its 20 seconds, the wire (sign, refuse, version), `DisplayBook` (latest wins, idle after 60 s, the logo kept by its hash), `Routing.silent` and that no printing path takes a display, `LocalAnswers` taking a display and refusing a bad one. All existing tests pass.
- **Database suite** (`db/tests/customer-display.test.cjs`, one transaction rolled back, never side by side with another suite on dev): 0130's checks, `push_printer_save` with a display (taken; not the receipt printer; refused without code or address; a till of another store refused), the back office's saves.
- **Two emulators**, per the emulator note: windows open, said before each step, the screen read before every tap. One set up as a customer display; the other a till with the made-up shop and then the made-up restaurant on the offline plan, the display added on the tablet (Settings, Printers). Seen: each line as it is added, the totals, the change after Pay, the idle screen, the display switched off and on again, and that none of it needs the internet (the offline plan's tablet has no server to reach).
- **Not seen:** the back office page in a browser (it needs a login: covered by the suite and a build); two real tablets on a real Wi-Fi; a till older than this beside a display; a cloud till paired from the back office on a device.

## 10. Building beside the loyalty work

The loyalty session is changing the same till in the main folder (migration 0128, Room 32). This work is done in its own worktree (`claude/customer-display`) and put on `restopos` by fast-forward after a rebase. The migration is 0130 and Room is 33. The parts that touch nothing of loyalty's go first (the wire, the display's mode, the picture and their tests); Room 33, `LocalAnswers` and Pay's one call come once loyalty's Room 32 is committed. Committed on `restopos`, not pushed, no tag, no version raised (the release does that).

## 11. Version 2, asked the same day (2026-10-21, afternoon)

After seeing version 1 on two emulators, the owner sent a photo of a shop's customer display (a table of lines with Price and Disc%, a block of Total, Discount, VAT, Payment, Balance and Total quantity, the shop's name on top and the date at the foot, the logo and a poster on the right) and wrote that a display is sometimes connected by cable. Their answers (taps):

| Question | Answer |
|---|---|
| Layout | **Like the photo**, restaurants and shops alike |
| The right-hand side | **Several pictures, in turn** |
| Where the pictures are chosen | **On the till** (Settings, Printers, the display) |
| Cable displays | **A second screen Android sees** (HDMI or USB-C monitor, a terminal with a built-in customer screen) **and a 2-line pole display** |
| The pole display connects by | **USB** |

**This changes two earlier answers:** pictures are now wanted (section 1 said words only: that meant product pictures, and still does; these are the shop's own posters), and the idle screen shows them too.

### 11.1 The table layout

- Head: the business's name. Foot: today's date, in the till's language.
- Lines as a table: Description (with add-ons beneath) · Qty · Price (the listed price of one) · Disc% · Amount. Disc% is what a shop's line discount took off its listed price (`ticket_lines.list_price` against `unit_price`), whole percent, 0 when none; a restaurant's lines always show 0, it has no line discount.
- The block under the lines, every figure the receipt has:
  - **Total**: the lines at their listed price, before any discount (Σ qty × list price + add-ons).
  - **Discount**: all that was taken off, the lines' discounts and the order's discount together.
  - **Service** and **Rounding**: shown only when not zero, or the block would not add up for a restaurant.
  - **VAT**: included or added, as now ("VAT included" when the prices hold it).
  - **Payment**: what was paid on it so far (a split bill); after Pay, what was handed over.
  - **Balance**: what is left to pay (Total − Discount + added VAT + Service + Rounding − Payment), large. After Pay it is the change, labelled **Change**, large and green.
  - **Total quantity**: the number of items.
  These are held to add up in the unit tests.
- Right-hand side: the logo, then the pictures in turn. Without pictures, the logo alone.

The message carries the new figures as fields with defaults, so `DisplayWire.VERSION` stays 1 and a display on version 1 still reads a newer till.

### 11.2 Pictures in turn

- Up to 5, picked on the till from the tablet's photos (Settings, Printers, the display, Pictures), each shrunk to at most 1280 px and kept as JPEG in the till's database (Room, as product pictures are, so a backup carries them), per display.
- Shown on the right during a sale and filling the idle screen between sales, 8 seconds each.
- Sent to a Wi-Fi display by hash, one picture per exchange, only those it says it lacks (a line holds at most 256 KB). A cable screen draws them straight from the till.

### 11.3 A second screen on a cable

- The till shows the customer display on any second screen Android itself sees (Android's Presentation): an HDMI or USB-C monitor, or a terminal with its own customer screen. Same drawing as the Wi-Fi display (one stateless screen fed the picture, the logo and the pictures), fed straight from the till's DisplayFeed, no wire, no pairing.
- Switched on in Settings, Printers ("Show the customer display on a second screen"), with its message and pictures, kept on that tablet like the label printer. **My decision:** a cable screen and a pole display belong to the tablet they are plugged into, so they are tablet settings, not back-office rows: no migration, 0130 unchanged.

### 11.4 A 2-line pole display (USB)

- Text only, 2 lines of 20: during a sale the last line rung up and its amount, then "TOTAL Rs …"; after Pay "CHANGE Rs …"; between sales the message. ASCII only (French accents taken off).
- Driven like a printer, from the till, over USB. The commands are the common Epson-style set; the USB side depends on the chip in the display (USB-serial: Prolific, CH340, FTDI, or USB CDC). **Waiting on the owner:** the display's make and model (or its USB ids, which the till can list), and whether to add the `usb-serial-for-android` library (published on JitPack, not on Maven Central where the till's libraries come from): theirs to say, as ZXing was. Built last; its first real test is the owner's device.

### 11.5 Order and testing

Built in the order it can be tested: the table layout (unit tests, the emulators), the cable screen (an emulator's simulated second screen), the pictures (the emulators), the pole display last (unit tests of the bytes it sends; the device itself is the owner's).
