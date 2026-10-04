# Android — RestoPOS till

Kotlin + Compose + Hilt + Room + WorkManager + Ktor (OkHttp). Min SDK 26,
compile SDK 36.

Built: sign-in, store and device setup, the menu mirrored into Room by the
pull worker, a start screen, and four tabs along the bottom:

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
- **Register:** the order and a keypad on the left, the category strip in the
  middle (each category in the colour set in the back office), the open
  category's items on the right, Pay along the bottom. A number typed on the
  keypad is used by what is tapped next: an item (that many), the × key (the
  selected line's quantity), Guests, or Cash (the amount received; nothing
  typed means exact). Cash and Card pay everything unpaid in one receipt.
  Tab name, guests and the dining option are stored on the ticket. Actions
  holds New order and the discounts. The magnifier searches the whole menu.
  When the categories do not all fit, the strip pages and its last slot is
  a down arrow; the item grid shows the same arrows past a screenful.
- **Orders:** the orders opened on this tablet that are not fully paid; tap
  one to put it back on the register.
- **Receipts:** the receipts issued on this tablet.
- **Settings:** this till, the state of its sync, rejected changes, sign-out.

Pay (the bar under the items) is the full payment screen: split by item, any
payment type, a reference.

Not built yet: tables and a floor plan, customers, sending to the kitchen,
tips, splitting a bill evenly, service charge and rounding settings, refunds,
printing, barcode scanning, pay in and pay out, X and Z reports, locking
after inactivity, a manager's PIN to override a refusal, QR sign-in. A till only shows its own orders and
receipts: the pull does not bring other tills' tickets down.

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
