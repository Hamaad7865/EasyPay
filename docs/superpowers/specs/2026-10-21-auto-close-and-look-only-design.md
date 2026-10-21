# The day closes itself, and Look only

2026-10-21. Asked by the owner; the two choices below are theirs, the rest is mine
to be approved with this spec.

## Why

1. A cashier or an owner forgets to close the day. The owner: "if day is not close
   today for example 1st of Jan, then on 2nd of January 00:00 automatically close
   1st of January", as a setting.
2. Nobody can get into the till without opening the day: the start screen sends
   whoever may open it straight to the drawer count, and turns away whoever may
   not. The owner: "if an owner wants to check something in the app, he cant, he
   needs to open the day just to check something".

They go together: after a night's automatic closing every till starts the morning
with no day open, which is when an owner most wants to look without opening it.

## The owner's answers

- Orders still unpaid when the day closes itself are **carried into the next day**
  (not: the closing skipped that night).
- Getting in to look: **a Look only button on the start screen, with no clocking
  in** (not: clocking in as the only way in).

## What is there now (read in the code on 2026-10-21)

- A till owns its day: `shifts` (Open day, with the drawer counted) and
  `day_closes` (the Z). `CashOps.closeDay` needs someone signed in, an open day and
  no unpaid order; it writes `shift.close` and `day.close` together, clocks out
  whoever is still in, prints the Z and resets the bill and customer numbers
  (`SessionStore.dayClosed`).
- A till with no PINs has no days: its sales are closed on their own
  (`CashOps.closeUnclosed`, which can carry unpaid orders into the next day).
- The back office never closes a day itself; it asks, and the till closes it at its
  next sync **as of when it was asked** (0091: `RequestRules.moment`,
  `CashOps.closeDayAsked`). This spec closes the same way, as of the set time.
- The day is only looked at by the start screen (`StartScreen`, `ClockScreen`).
  Once in, the register does not check for an open day.
- `push_shift_close` refuses a closing with no count; `push_day_close` keeps its
  `totals` as given (free jsonb). An op with no `employee_id` is taken as the
  till's own login (`sync_push`, `v_emp := p_employee_id`).
- `PullWorker` runs only with a network, so an offline-edition tablet never runs
  it: nothing here may hang off a sync.
- A tablet changes a setting through `settings.save`, which takes named keys only
  (last extended by 0128 for loyalty points); on the offline edition
  `LocalAnswers.settingsSave` answers it.
- The back office's Day closing report shows the drawer from the shift's
  `counted_cash` and `expected_cash`.

## Part 1: the day closes itself

### The setting

**Close the day automatically**, off unless switched on, with a time (HH:MM, the
tablet's local time). Switched on, it starts at 00:00. One setting for the whole
business, every till.

- Back office: POS settings, in the day closing section. The words say a business
  open past midnight should pick an hour when it is closed (05:00, say), and list
  any till on a build too old to close itself.
- Tablet: Settings, where the day is closed, for whoever may change the settings
  (`settings.device`). This is the only place on the offline edition.
- Stored as `pos_settings.data.autoClose`: `"HH:MM"`, or absent / null for off.
  `PosSettings.autoClose: LocalTime?`.

### When a till closes its day

The **cut-off** is the first moment at the set time after the day was opened (for
a till with no PINs: after the first sale no closing covers). A till checks, and
closes when it should:

- **Nothing written down since the cut-off:** the day closes **as of the cut-off**.
- **Something written down since the cut-off** (a sale, a refund, cash in or out,
  a drawer count: what `usedSince` already looks at): it cannot be dated back,
  since those would fall outside every day. The day closes **once 30 minutes go
  by with nothing written down**, as of that moment.
- A till left off for several days gets **one** closing, as of the first cut-off.
  The next day starts when someone opens it.
- Before the cut-off, nothing happens.
- A day opened at 23:50 with the time at 00:00 follows the same rules: closed at
  00:00 if nothing was sold, or 30 quiet minutes after its last sale.
- Adding to an order that is not paid is not "written down": the order is carried
  over, and it counts on the day it is paid.

These rules are one pure function, `AutoCloseRules.decide(openedAt, cutoffTime,
zone, lastWrite, now) -> CloseAt(moment) | Wait`, held to unit tests.

### When the till checks

The closing is dated by the rules above, not by when the check runs, so the check
only has to come before anyone can sell:

- when the app starts and each time it comes back to the front;
- every minute while it is open;
- before a sign-in on the start screen;
- in `PullWorker` as well, for tills that sync.

### What the closing does

What `closeDayAsked` does, with these differences:

- **By nobody.** The ops carry no `employee_id`, so the server takes them as the
  till's own login; the till and the back office show the closing as
  "Automatically", not as that login's name.
- **The drawer was not counted.** `shift.close` must carry a count, so it carries
  what was expected (as a back-office close with no count does). `day.close`
  carries `totals.auto = true` and no `counted`. Everything that shows a closing
  reads `auto` and says **"Drawer not counted (closed automatically)"**, never a
  difference of zero: the Z, the till's Reports, the back office's Day closing
  report and its CSV.
- **Unpaid orders carry over** into the next day, as `closeUnclosed` already can.
  `totals.carried` is how many; the Z and the report say "N orders carried into
  the next day".
- Whoever is still clocked in on that till is clocked out as of the closing.
- The bill and customer numbers start again (`SessionStore.dayClosed`), as for any
  closing.
- The Z prints if a receipt printer answers. If not, nothing is said at the time
  (nobody is there); it is in Day closing to reprint.
- **The next person is told once**, at their next sign-in: "The day was closed
  automatically at 00:00 (no. 42). The drawer was not counted. 3 orders were
  carried into today." Kept on the tablet (`SessionStore`) until said, so closing
  the app does not lose it (the back-office close's notice is lost that way today).
- On the till: `DayCloseEntity` gains `auto` and `carried` (Room 34 to 35), filled
  from `totals` when a pull brings closings.

The same for a till with no PINs, through `closeUnclosed` given the moment.

### Old tills

Only tills on the new build (34) close themselves. The back office says which
tills are on an older build next to the setting, as it does for the close and
cash-out keys (`REQUEST_BUILD`). `MIN_TILL_VERSION` is not raised.

## Part 2: Look only

### Getting in

- **Start screen:** a **Look only** button wherever the start screen is shown and
  anyone has a PIN. It lists everyone with a PIN, clocked in or not. The right PIN
  lets them in to look, **without clocking in**.
- **A clocked-in person's PIN with no day open:** someone who may open the day
  gets **Open the day** (first, as today) or **Look only**. Someone who may not is
  let in to look, told "The day is not open. Someone allowed to open it has to."
  (Today they are turned away.)
- **Clocking in with no day open:** the dialog's "Not now" becomes **Look only**.
- A till with no PINs is unchanged: it has no days and no sign-in.

### Inside

A strip along the top of every screen:

- came in by clocking in, day not open: "The day is not open" and **Open the day**
  (for whoever may open it);
- came in by Look only: "Look only" and **Clock in**.

**What works:** Reports, past Z reports, Today; Receipts (look up, reprint);
Floor plan and Orders, to look at (orders carried over from last night show here);
Menu and stock, sold out, prices, labels; Customers' details; Bookings; Settings,
printers, staff; Get changes. Each still as the person's role allows.

**What waits:** anything that takes an order or moves money. New order, adding to
an order, sending to the kitchen, voiding or editing an order; payment, split bill,
refunds, credit notes; cash in, cash out, opening or counting the drawer;
deposits and customer account payments; changing a payment's method; collecting
from the takeaway board.

Tapping one says why and offers the way out, then comes back to where they were:

| Came in by | Day open | Says | Offers |
|---|---|---|---|
| clocking in | no | The day is not open. | Open the day (count), if allowed |
| Look only | no | You came in to look. Clock in to take orders. | Clock in, then Open the day if allowed |
| Look only | yes | You came in to look. Clock in to take orders. | Clock in |

The rule is one function, `SellGate.why(dayOpen, clockedIn, mayOpen) -> null |
Blocked(text, offer)`, held to unit tests. It is checked where the till writes
(placing and paying orders, cash moves, the drawer, deposits, accounts, payment
corrections), not only by hiding buttons, so no screen missed in the list can get
past it.

If the day closes itself while someone is signed in, they are simply in the first
row from then on. Guest QR ordering already stops while no day is open
(`GuestLink`); unchanged.

## Server and back office

- Migration **0133** (0132 is the MRA phase 2 plan's): `push_settings_save` takes
  `autoClose`, `"HH:MM"` from 00:00 to 23:59, or null to switch it off; anything
  else is `bad-value`. Nothing else changes on the server: closings use the
  existing `shift.close` and `day.close`.
- Back office: the setting on POS settings (and the old-build list); Day closing
  report and CSV read `totals.auto` and `totals.carried`.

## Checks

- Till unit tests: `AutoCloseRules` (before the cut-off; idle since it; used after
  it and quiet for 30 minutes; several days missed; a till with no PINs; a day
  opened at 23:50) and `SellGate` (every row of the table).
- `db/tests`: a dev-safe suite for 0133 (a time saved, a bad one refused, null
  turns it off, other keys untouched).
- Web: `lib` tests for the setting and the report's wording; type-check; build.
- Emulator, under the shared-emulator rules: a debug-only hook that runs the
  check at a given moment (as `DEMO_PULL` does for requests), to see a day closed
  at the cut-off, one closed after 30 quiet minutes, the carried orders, the
  notice, and every row of the Look only table.
- Not testable here: a real printer printing the Z at midnight.

## Not in this

- Closing every till of a business at once from the server.
- A reminder before the set time.
- Look only as a permission of its own (everyone with a PIN may look, inside what
  their role allows).
