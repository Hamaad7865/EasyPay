# Android — EasyPay till

Kotlin + Compose + Hilt + Room + WorkManager + Ktor (OkHttp). Min SDK 26,
compile SDK 36.

Built: sign-in, store and device setup, the menu mirrored into Room by the
pull worker, a start screen, and behind it the till as designed in the v2
handoff (`feature/main/MainShell.kt` holds every screen):

- **Top bar:** the menu key, the service screens (Tables, Quick sale,
  Takeaway, Kitchen, Bookings, Orders) with a count on the ones that have
  something waiting, the clock, and who is signed in. A dot beside the clock
  is amber while changes wait to sync and red when the till needs someone.
- **Side menu:** the service screens again, then Today's sales, Menu & stock,
  Cash drawer, Receipts, Customers and Settings; the language (English or
  French, for the till's own words); Switch staff (tap a name, enter its
  PIN); Lock the till.
- **Tables (the floor):** one tab per area of the floor plan with how many of
  its tables are taken. A table is free, seated (blue, with what it owes and
  how long it has been), waiting for its bill (amber) or reserved (violet,
  dashed, with the booking's time). Its chairs light up for the guests
  seated. Beside the plan: the orders in progress and who arrives next. Tap a
  free table and a number of guests: the order is opened there and then
  (`TicketRepository.seat`). Tap a seated one: its order, Print bill, Pay,
  Open order; with nothing ordered, Free the table, which closes the empty
  order (`ticket.cancel`). Tap a reserved one: the booking, "Guests arrived ·
  seat now", Release table.
- **Order:** the order on the left, split into what the kitchen has and what
  is new. A table's order has a covers stepper; any other order has its kind
  (Counter, Takeaway, Delivery, a tab), and a takeaway or delivery has the
  customer's name, phone and address. Tap a new line for minus, plus and
  Remove; tap a sent line for Void (the kitchen gets a VOID ticket; needs
  `sale.void_sent_line` or an approval). The menu is on the right: categories
  in their colours, a search over the whole menu, items as tiles with their
  price, a tag, OPTIONS, SOLD OUT, and how many are on the order unsent. An
  item with add-on groups asks its options; press and hold any item to add a
  kitchen note or several at once. Under the order: Print bill (tables),
  Split, Clear new, More (discount, move to another table, change server,
  order note, customer, print the kitchen order again, cancel the order),
  then Send to kitchen and Pay.
- **Send to kitchen** puts what the kitchen has not had on the kitchen display
  as one ticket, prints it on the printers its categories are ticked for, and
  marks it sent. A printer that does not answer does not hold the order back:
  it is on the display, the till names the printer, and the paper can be sent
  again (Settings > Printers, or More > Print the kitchen order again). An
  order on a table then goes back to the floor. An order paid without being
  sent goes to the kitchen when it is paid.
- **Split** opens the split check: the order's unpaid lines in checks side by
  side, a line moved or divided between them, one check per seat, a bill and
  a payment per check.
- **Pay:** the amount to charge, the restaurant's payment types, and for cash
  a keypad, the amount tendered, round amounts and the change. Full bill is
  one payment for what is left. Split equally takes the amount in equal
  shares, each paid its own way; the shares are kept until they add up and
  then go out as ONE receipt, with a printed copy per guest. Split check goes
  to the split check screen, and a check paid from there is a receipt of its
  own. When everything is paid: the change to give, Print (another copy),
  Email and WhatsApp (the receipt as text, handed to the tablet's own mail or
  WhatsApp app), and on to the next sale, the floor or the board.
- **Service charge:** the back office's percentage (POS settings) on orders
  served at a table, on the bill and the receipt as its own line. The server
  works the amount out from the percentage.
- **Kitchen display:** every send is a ticket: where it is for, how long it
  has waited (amber from 8 minutes, red from 15), its lines with their
  options and notes. Tap a line when it is done; Bump when the ticket is at
  the pass; Recall last brings the last one back. A station is a kitchen
  printer of the back office, so the screen and the paper agree on who cooks
  what. "All day" adds up what is still to cook.
- **Takeaway & delivery:** a board with New, In the kitchen and Ready. An
  order gets a number that counts up through the day (A-1, D-1; counter sales
  are C-1) and a time it is due (POS settings, Takeaway time). It moves to
  the kitchen when it is sent, to ready when its last kitchen ticket is
  bumped (or with the key on its card), and off the board when it is
  collected; one collected unpaid goes through the payment first. Tap the due
  time or a delivery's address to move the time or pick the rider.
- **Bookings:** today's bookings with their covers, table and notes: New
  booking, Confirm, No-show, Assign table (pick a free table on the floor),
  Seat (opens the table's order with the party's size). The back office has
  the days ahead.
- **Orders:** every order opened on this tablet that is not fully paid, as a
  list to search and sort.
- **Today's sales:** this till's receipts today: net sales against the same
  hours a week ago, covers, average check, what is still open, sales by hour,
  payment mix, best sellers and sales by order type. Needs
  `shift.view_report`, or someone who has it to show them.
- **Menu & stock:** every item with its category, station, options and price,
  and a switch for sold out (`item.set_available`; needs `items.availability`
  or `items.edit`, or an approval). A sold-out item stays on the menu, greyed.
  Tapping an item's price changes what it costs (`item.set_price`; needs
  `items.edit`, or an approval): at once on this tablet, on the others when
  they sync. Orders already open keep the price each line was rung up at. The
  server writes every change of a price down (`item_price_changes`: from, to,
  when, who, who approved), and the item's page in the back office lists them.
- **Cash drawer:** the drawer counted by note and coin (Rs 2,000 to Rs 1),
  with what it should hold and the difference for those who may see the
  figures (others count blind). Open drawer, Cash in, Cash out, Print X
  report, Record this count (a handover), and Close shift & print Z report:
  the sales period is closed from the count and, if chosen, the day with it.
- **Approval:** something the person signed in may not do (a refund, a void
  after the kitchen has it, opening the drawer, cash in and out, closing the
  period or the day, a discount, marking an item sold out, the figures) asks
  who approves. They tap their name and enter their own PIN; it is done in
  the cashier's name with `approved_by` on the op.
- **Start screen:** what the app opens on once the tablet is set up, and
  where Lock returns. Three states:
  - nobody has a PIN (set in the back office, under Staff): one button, Open
    register. An update never locks a restaurant out.
  - staff have PINs and nobody is clocked in: "Sales period is closed" (or
    "No one is clocked in") with Clock in/out.
  - someone is clocked in: their names as tiles. Tap yours, enter your PIN.
    If no sales period is open, someone with `shift.open_close` confirms the
    cash in the drawer and that opens it.
- **Clock in/out:** two columns, each name needs its PIN. A punch is one row,
  never changed; "clocked in" is "the last punch was in".
- **Who did it:** every outbox op carries the signed-in member of staff, and
  the server acts as them. What the server would refuse is refused on the
  till before money is recorded.
- **Receipts:** tap one to see it, print it again (the same paper: what a
  receipt printed is kept with it), refund it, or correct its payment type. A
  refund is the whole receipt or part of it: the sheet lists the lines, with
  how many of each come back, a reason and how the money goes back. The till
  works the amount out as the server does (`RefundCalc`, its figures pinned
  by tests on both sides), and a receipt can be refunded again until nothing
  of it is left. A receipt issued before version 8 of the tablet's database
  can only be refunded whole.
- **Customers:** search, add, edit; More > Customer puts one on an order.
- **Settings:** this till, notifications, reports (past periods and day
  closings), payments, printers with a test print and the print jobs, the
  display (light mode, keep the screen on), support and help.
- **Barcodes:** a scanner that behaves as a keyboard (USB, or Bluetooth
  paired as a keyboard) adds the item whose barcode it reads while the order
  screen is open. The barcode is typed or scanned on the item in the back
  office. Scanning with the tablet's camera is not built.
- **Locking:** POS settings in the back office can lock the till after so
  many minutes without a touch. It returns to the start screen with the order
  kept; the kitchen display and a payment under way do not lock.
- **Language:** the till's own words in English, French and Kreol Morisien
  (side menu). The Kreol is waiting for a native speaker to read it through.
- **What the till says about itself:** a strip under the top bar when its
  clock is five minutes or more from the server's (receipts carry the
  tablet's time), and when the server says this build is too old to sync
  (`MIN_TILL_VERSION` on the API, see `neon.ts`): it keeps selling and keeps
  its sales until it is updated. A crash is written to a small file (where in
  the program, the version, the tablet; nothing of a sale) and sent at the
  next sync; the admin area lists them under Crashes.
- **Splitting equally** keeps the shares already taken on the tablet between
  guests, so a tablet that stops in the middle still knows what was paid.
- **Printing** is done by the tablet itself over the local network (a
  printer's IP address, port 9100) or a USB cable, in ESC/POS, for 58 mm and
  80 mm paper. It does not need the internet.

Not built yet: tips, a discount on one item (the server's payment function
only knows discounts on the whole bill), merging two orders into one,
Bluetooth printers, scanning a barcode with the camera, QR sign-in, card
terminals (a card payment is recorded by hand once the terminal has approved
it), changing an item's price on the order, fixtures on the floor plan (a
bar, the entrance), charging a hotel room, sending a receipt by e-mail or SMS
from a server.

A till only shows its own orders, kitchen tickets and receipts: the pull does
not bring other tills' tickets down. So a table that is taken on one tablet
shows as free on another, and the kitchen display shows what was sent from
the tablet it is on. The server already sends the store's open tickets;
applying them on the till, and pulling often enough for a kitchen tablet, is
the next step. Bookings, the menu and sold-out items are shared between tills.

Printing has unit tests that read the printed bytes back, but has not been
run against a real printer.

The layout is drawn for a 1280 x 720dp landscape tablet and scaled to the
screen it runs on (`MainActivity.attachBaseContext`); the app is locked to
landscape. The redesign's colours, icons and shared controls live in
`core/ui/V2.kt`; `core/ui/PosTheme.kt` gives the older screens the same
palette. The design asks for the Manrope typeface; the till uses the
tablet's own until the font file is added to `res/font`.

It has been run on a 2560 x 1600 emulator against the dev branch. The three
checks below are the first thing to do on a real tablet.

## Build

1. Android Studio (SDK 36) and JDK 17.
2. Create `android/local.properties` (gitignored):
   ```
   sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
   functionUrl=https://br-...-api.compute.c-4.ap-southeast-1.aws.neon.tech
   authUrl=https://ep-....neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth
   ```
   The URLs are `NEON_FUNCTION_API_BASE_URL` and `NEON_AUTH_BASE_URL` from the
   root `.env.local`. They become `BuildConfig` fields; a trailing slash is
   fine. Use the dev branch values unless you mean to point a build at
   production.
3. `cd android && ./gradlew :app:assembleDebug`
   The APK lands in `app/build/outputs/apk/debug/`.
4. `./gradlew :app:testDebugUnitTest` checks that the till's totals match the
   figures the server stores for the same sales.

### The build for a restaurant's tablets

A debug build is for the emulator: anyone with a USB cable can read its
database (`adb run-as`). Tablets in a restaurant get the release build.

1. Make the signing key once, and keep the file and its passwords somewhere
   safe: every later version must be signed with the same key, or the tablets
   will refuse the update.
   ```
   keytool -genkeypair -v -keystore C:/keys/restopos.jks -alias restopos -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Say where it is in `android/local.properties`, and put the production
   `functionUrl` and `authUrl` there:
   ```
   keystoreFile=C:/keys/restopos.jks
   keystorePassword=...
   keyAlias=restopos
   keyPassword=...
   ```
3. Raise `versionCode` (and `versionName`) in `app/build.gradle.kts` for every
   build that goes out, then `./gradlew :app:assembleRelease`. The APK lands
   in `app/build/outputs/apk/release/`.

## Check on a device (Phase 1 exit)

1. Web: edit an item price, save.
2. Tablet: sign in with the owner email, pick the store, give the device a
   code that no other till in the store uses, seed the demo menu if empty. The
   pull runs on start; the grid updates within seconds.
3. Airplane mode on, force-stop, reopen: the app opens straight on the menu
   (a set-up tablet does not ask for sign-in again) and the menu still shows.

## How sync and sign-in behave

- **Pull:** pages until `has_more` is false, each page and its cursor in one
  Room transaction. Network errors retry with backoff; a rewritten table on
  the server (the `epochs` map changes) clears the mirror and pulls from 0.
- **Session:** the auth cookies are stored on the device, and the API token is
  refreshed from them shortly before it expires or when a call returns 401.
  If the session itself is gone, the worker stops and the next sign-in resumes.
- **Push:** outbox rows go up in order, 50 at a time. `applied` removes the
  row, `rejected` moves it to the dead-letter state with the server's code,
  `retry` leaves it queued. A push that ends on a server error is tried again
  with a growing pause, and every sync (at least every 15 minutes) sends what
  is still waiting. A line carries the price and modifier prices this
  till charged, and a discount carries the amount it took off, so the server
  stores the receipt as printed.
- **Receipt numbers:** the sequence is kept on the device row and only moves
  forward; a pull never lowers it.
- **Sign-out:** refused while unsynced changes are in the outbox; otherwise it
  clears the session and the local database, online or not.
