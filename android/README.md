# Android — RestoPOS till

Kotlin + Compose + Hilt + Room + WorkManager + Ktor (OkHttp). Min SDK 26,
compile SDK 36.

Built: sign-in, store and device setup, the menu mirrored into Room by the
pull worker, a start screen, and the screens behind the top bar:

- **Top bar:** Log out (back to the start screen) and the sync mark on the
  left (green: nothing waiting here; amber: changes waiting; red: refused
  changes or a sign-in needed; the till does not test the network itself). In
  the middle, the side menu's button and Floor plan, Orders, Receipts. On the
  right, New order. The side menu pushes the screen aside and also holds
  Settings. There is no tab bar along the bottom.
- **The register is its own screen:** New order, an order or a table opens
  it; Close goes back to the list it was opened from. Its bar shows who is
  selling and the magnifier. The till opens on it after the start screen.

- **Start screen:** what the app opens on once the tablet is set up, and
  where Log out returns. Three states:
  - nobody has a PIN (set in the back office, under Staff): one button, Open
    register, as before. An update never locks a restaurant out.
  - staff have PINs and nobody is clocked in: "Sales period is closed" (or
    "No one is clocked in") with Clock in/out.
  - someone is clocked in: their names as tiles. Tap yours, enter your PIN.
    If no sales period is open, someone with `shift.open_close` confirms the
    cash in the drawer (the cash count) and that opens it.
- **Clock in/out:** two columns, each name needs its PIN. A punch is one row,
  never changed; "clocked in" is "the last punch was in".
- **Sales period:** one per till. Closed from Settings with a blind count;
  the till then shows opening amount, cash taken, expected, counted and the
  difference. The server works out the same expected figure.
- **Who did it:** every outbox op carries the signed-in member of staff, and
  the server acts as them. The register shows their name. What the server
  would refuse (payment or a discount without the permission, a restricted
  discount without someone allowed to give it) is refused on the till before
  money is recorded.
- **Register:** the order and a keypad on the left, the categories two across
  in the middle (each in the colour set in the back office, blue when none is
  set), the open category's items on the right, Pay along the bottom. A number typed on the
  keypad is used by what is tapped next: an item (that many), the × key (the
  selected line's quantity), Guests, or Cash (the amount received; nothing
  typed means exact). Cash and Card pay everything unpaid in one receipt.
  Tab name, guests and the dining option are stored on the ticket. Actions
  holds New order and the discounts. The magnifier searches the whole menu.
  When the categories do not all fit, the grid pages and its last row is
  a down arrow; the item grid shows the same arrows past a screenful.
- **Order header:** the order's name top left (the tab name, else its table,
  else "Direct sale"). Under it: Dine-in / Takeaway, and the table ("Assign
  table" until it has one; tap to pick or move). An order on a table, or a
  named tab, is table service and also has "By course" (lines under Course 1,
  Course 2, ... with "Add a course"; new items go to the course that is lit;
  the course is sent with the line) and the guests chip. Naming an order (Tab
  name) takes it off its table: the name is what the guest's bill will carry.
- **Floor plan:** the store's floor plan, as laid out in the back office (Floor plans),
  scaled to the screen, one tab per area. Each table shows its name and,
  under a line, what the view chosen bottom left says: Covers (a dot per
  seat, lit per guest), Total, Time or Status. A table with something to pay
  has a green marker. Tap a free table to start an order on it (it asks how
  many guests; the order is created with its first item), tap an occupied one
  to bring its order back. On the register, the Tables key opens
  the plan, or the table whose name was typed on the keypad first. Actions
  has "Move to another table".
- **Orders:** the orders opened on this tablet that are not fully paid, as a
  table: a tab per dining option with its count (an order with none counts
  under the default), a search (order, floor or waiter), and the columns
  Order, Floor, User, Covers, Created, Last edit, Course, Total, Payment.
  Tap a column to sort by it, tap an order to put it back on the register.
  Last edit is the newer of the order's own change and its newest line, as
  an age: green, amber from 30 minutes, red from an hour.
- **Receipts:** the receipts issued on this tablet.
- **Settings:** this till, the state of its sync, rejected changes, sign-out.

Pay (the bar under the items) opens the payment screen, titled with the
order's name and what is due. Left, the order summary: with more than one
line, tap a line to leave it for another guest's payment (split by item).
Middle, the payment types from the back office, grouped Cash / Cards / Other.
Right: the payment amount, the amount received (cash: exact, the next notes
up, or Custom on a number pad; other types: an optional reference), the
change, and Pay. Cancel goes back to the order. Pay ignores taps in its first
moment on screen, because it sits where Pay on the register was.

Not built yet: customers, sending to the kitchen,
tips, splitting a bill evenly, service charge and rounding settings, refunds,
printing, barcode scanning, pay in and pay out, X and Z reports, locking
after inactivity, a manager's PIN to override a refusal, QR sign-in. A till only shows its own orders and
receipts: the pull does not bring other tills' tickets down. So a table that
is occupied on one tablet shows as free on another. The server already sends
the store's open tickets (0048); applying them on the till is the next step.

The layout is drawn for a 1024 x 720dp landscape tablet and scaled to the
screen it runs on (`MainActivity.attachBaseContext`); the app is locked to
landscape. Colours live in `core/ui/PosTheme.kt`.

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
  `retry` leaves it queued. A line carries the price and modifier prices this
  till charged, and a discount carries the amount it took off, so the server
  stores the receipt as printed.
- **Receipt numbers:** the sequence is kept on the device row and only moves
  forward; a pull never lowers it.
- **Sign-out:** refused while unsynced changes are in the outbox; otherwise it
  clears the session and the local database, online or not.
