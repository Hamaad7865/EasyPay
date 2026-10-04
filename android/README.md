# Android — RestoPOS till

Kotlin + Compose + Hilt + Room + WorkManager + Ktor (OkHttp). Min SDK 26,
compile SDK 36.

Built: sign-in, store and device setup, the menu mirrored into Room by the
pull worker, a start screen, and the screens behind the top bar:

- **Tabs along the bottom:** Register, Tables, Orders, Customers, Receipts,
  Settings, and at the end three dots for the sync (green: nothing waiting
  here; amber: changes waiting; red: refused changes or a sign-in needed; the
  till does not test the network itself). The bar along the top says who is
  signed in; on the register it also has the magnifier. Log out is at the top
  of Settings.
- **The register always holds an order:** the one opened from Tables or
  Orders, or a new direct sale. Send, On hold, a payment and Cancel order all
  leave it on a new one. Actions has New order, naming the order, the bill,
  the remark, the waiter and the discounts.
- **Beside the keypad:** Edit order (the keypad makes way for the whole order;
  tick items, then move them to a seat or a course, or remove them), On hold
  (the order is put away without going to the kitchen), Tables (Switch Table
  when the order is on one) and the quick payment key (card or cash, set in
  the back office under POS settings, Payment options).
- **C** clears what is typed; with nothing typed it asks to cancel the order.
  Yes takes every item off (the kitchen gets a void for what it already has,
  which needs someone allowed to void), frees the table, and puts the register
  back on a direct sale. A partly paid order cannot be cancelled.
- **Seats:** "Select a seat" above the items says who the next items are for:
  the table, a seat, or a new seat (+). The order can be listed by course, by
  seat, or as rung up. The seat prints on the kitchen ticket, and Split Check
  has "One check per seat".
- **Customers:** the Customers tab lists them (search, New customer, tap to
  change). Assign customer on the register puts one on the order; their name
  is the order's name when it has no table or tab name, and prints on the bill
  and the receipt. They are also kept in the back office, under Customers.
- **Approval:** something the person signed in may not do (a refund, a void
  after the kitchen has it, opening the drawer, cash in and out, closing the
  shift or the day, a discount, the reports) asks who approves. They tap their
  name and enter their own PIN; it is done in the cashier's name with
  `approved_by` on the op.

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
  in the middle (all in the till's blue), the open category's items on the
  right, and Send, Split Check and Pay along the bottom. A number typed on the
  keypad is used by what is tapped next: an item (that many), the × key (the
  selected line's quantity), Tables (that table), or the quick payment key
  when it takes cash (the amount received; nothing typed means exact). The
  quick payment key pays everything unpaid in one receipt. The name, guests,
  the order type and the customer are stored on the ticket. The magnifier
  searches the whole menu. When the categories do not all fit, the grid pages
  and its last row is a down arrow; the item grid shows the same arrows past a
  screenful.
- **Order header:** the order's name top left (the tab name, else its table,
  else its customer, else "Direct sale"). Under it: how the order is listed
  (By course, By seat, As ordered), the guests, the order type and Assign
  customer. Every order has courses: lines sit under Course 1, Course 2, ...
  with "Add a course", new items go to the course that is lit, and the course
  is sent with the line (the kitchen ticket only says the course when the
  order has more than the first). Naming an order (Actions) takes it off its
  table: the name is what the guest's bill will carry.
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
- **Settings:** a menu down the left, the chosen page on the right.
  - This till: who is signed in, Cash in, Cash out, Open drawer and Close
    shift, and the state of the sync, the shift, the printers and the network.
  - Notifications: what needs attention for as long as it is true (sign-in
    needed, refused changes, no receipt printer, failed print jobs) and what
    the printers reported while nobody was looking.
  - Cash drawer: Cash in, Cash out, Open drawer, Close shift (the blind count;
    there is no count that leaves the shift open), the shift's cash and its
    cash in and out. What the
    drawer should hold is only shown with `shift.view_report`.
  - Reports (`shift.view_report`): the shift, the day so far (also by
    category and by staff) with Close the day, and closed shifts and day
    closings to print again.
  - Payments (`receipts.view_all`): every payment since the last day closing;
    tap one for its receipt (print again, refund, correct the payment type).
  - Printers: each printer, whether it answers, what prints on it, a test
    print, and the print jobs since the app opened. A failed receipt, bill,
    slip or report has Try again (a receipt goes again without opening the
    drawer). A kitchen ticket is not re-sent from here: Save sends it again
    and marks the lines sent.
  - Display (`settings.device`): left-handed register, keep the screen on.
    Kept on the tablet.
  - Support: the till's details, Sync now, refused changes, and signing the
    tablet out (`settings.device`).
  - Help: how the till's own flows work.

Pay (the bar under the items) opens the payment screen, titled with the
order's name and what is due. Left, the order summary: with more than one
line, tap a line to leave it for another guest's payment (split by item).
Middle, the payment types from the back office, grouped Cash / Cards / Other.
Right: the payment amount, the amount received (cash: exact, the next notes
up, or Custom on a number pad; other types: an optional reference), the
change, and Pay. Cancel goes back to the order. Pay ignores taps in its first
moment on screen, because it sits where Pay on the register was.

- **Starting an order:** New order asks the order type (the back office's
  order types: Dine-in, Takeaway, ...). One that needs a table opens the floor
  plan; the others go straight to the register.
- **Save (send to the kitchen):** under the items, next to Print bill and Pay,
  for an order type that goes to the kitchen on Save. It prints what the
  kitchen has not had yet, each line on the printers ticked on its category
  (back office > Categories), with the table, the time and the waiter, marks
  those lines sent (`ticket.send`), and puts the order away. Opening the order
  again and saving again sends only what was added. A printer that does not
  answer keeps its lines unsent and says so; Save again retries them. An
  order type set to "when the bill is paid" prints its kitchen ticket after
  payment instead.
- **Delete and void:** a line the kitchen has not had is deleted (and its
  quantity can still change); one it has is voided, which prints a VOID ticket
  where the line printed. Neither asks for a reason.
- **Print bill:** the order as it stands, as often as asked. Nothing is
  recorded.
- **Actions:** transfer to another table, change waiter (`ticket.reassign`),
  a remark (prints on the kitchen order and the receipt), a discount in % or
  Rs, print the kitchen order again.
- **Payment:** the receipt prints by itself on the cashier's printer and the
  drawer opens if the payment type is set to open it. A remark can be added
  on the payment screen. With no decimals (or one), the total is rounded and
  the rounding is kept on the receipt.
- **Side menu** (the button left of Floor plan, and on the register next to
  the magnifier): the lists, then Cash drawer (open it without a sale, which
  is recorded; cash in and cash out with an amount and a reason: a slip
  prints and it counts in the drawer's expected cash), Closing (the shift:
  figures, print the report, close it; the day closing, the Z), and This till
  (refund or reprint, settings, lock). The day is closed on the screen that
  shows a closed shift, or from the menu when no shift is open: it needs the
  shift closed and no unpaid order, fixes the figures, prints, and with
  "start again each day" restarts bill numbers.
- **Receipts:** tap one to see it, print it again (the same paper: what a
  receipt printed is kept with it), refund it (the whole receipt, with a
  reason and how the money goes back), or correct its payment type.
- **Printing** is done by the tablet itself over the local network (a
  printer's IP address, port 9100) or a USB cable, in ESC/POS, for 58 mm and
  80 mm paper. It does not need the internet. Settings > Printers has a test
  print for each printer.

Not built yet: customers, a kitchen screen, tips, splitting a bill evenly,
service charge, refunding part of a receipt, barcode scanning, locking after
inactivity, a manager's PIN to override a refusal, QR sign-in. A till only shows its own orders and
receipts: the pull does not bring other tills' tickets down. So a table that
is occupied on one tablet shows as free on another. The server already sends
the store's open tickets (0048); applying them on the till is the next step.

Printing has unit tests that read the printed bytes back, but has not been
run against a real printer.

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
