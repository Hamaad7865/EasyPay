# Point of sale, after Carfection's: design (piece 1)

Asked 2026-10-10: "Look into how carfectionist does his point of sale module. Can we implement the same
here as well? Right now its not the same". Carfection is the owner's other product
(`C:\Projects\Carfection`, `apps/web/src/app/(app)/point-of-sale/`). Asked what the owner of a business
may do to a till from these pages, they chose "Everything Carfection does". Approved the same day: "yes
go ahead and write the spec, build it".

## Two pieces

1. **This document:** Carfection's layout, with rename and deactivate. Web pages and one reworded
   message in the till API. No migration, no new till.
2. **Afterwards, its own design:** closing a till's day and taking cash out from the back office. The
   tablet owns its day and works offline (`shift.open`, `shift.close`, `cash.move`, `drawer.count`,
   `day.close` all come from the till), so that needs a migration, the API and a till build, and a
   decision that is the owner's: the server closes the day outright, or the back office asks and the
   tablet closes it at its next sync.

## What Carfection has, and what EasyPay had

Carfection: one page of device cards (name, online dot, model, code, version, the till's open time and
who, cash collected, expected in drawer with the float, a key into the device), then "Recent cash-ups".
A device opens into four tabs: General, Settings, Cash flow, Traceability.

EasyPay: three pages under `/backoffice/pos` (Tills, Till activity, Cash flow), each with its own till
and day pickers; nothing per till to open; a till is named on the tablet and deactivated only in `/admin`.

## 1. The menu and the addresses

"Point of sale" keeps its group in the menu with one entry, **Tills**, at `/backoffice/pos`. A till's
own page is `/backoffice/pos/<till id>`, its tab in `?tab=` (`general`, `settings`, `cash`, `trace`).

The old addresses go on working: `/backoffice/pos/tills` goes to the cards; `/backoffice/pos/activity`
and `/backoffice/pos/cash` go to that tab of the till named in `?till=`, with the day they asked for,
or to the cards when no till is named.

## 2. The cards page

- A head line: how many tills, how many have their day open, and (for a role that sees reports) what
  was sold today.
- A grid of cards, two across, one on a narrow screen. A card is a link into the till. It says the
  till's name, a dot with when it last synced ("Synced 4 min ago", never "Online": a till left alone
  stops checking in so the database can sleep, and the page cannot know more), its store, code and
  build, flagged when a newer build is on another till. With its day open: since when and by whom,
  cash collected, and expected in drawer with "incl. Rs 1,000.00 float" and what was put in or paid
  out. With none: "Day closed. A day is opened on the tablet", and when it last closed.
- **Recent cash-ups**: the last ten closed days across the tills: opened, till, expected, counted,
  variance (balanced, short, over), with a link to Day closing.
- Deactivated tills in a group of their own under the rest, so one can be opened and reactivated.
- Money is shown to a role that sees reports, as before.

## 3. A till's page

A head with a way back, the till's name, its sync line, store, code, build, and "Deactivated".

- **General.** Taken today on this till, in all and by payment method (sales less refunds). The
  drawer: expected now and since when, or closed. Last activity. The latest six days: opened, by
  whom, what the drawer held (expected while open, counted once closed), the variance. And what
  EasyPay had that Carfection has no place for: last synced, sent, fetched, the build, sales that
  reached the server late today, and the app stopping in the last seven days.
- **Settings.** The name, with Save. Deactivate or Reactivate, asked twice. The store, the code and
  when it was set up, read only: the code is in every receipt number. For a login that may change how
  a till is set up (`settings.device`); anyone else sees it read only.
  - A new name reaches the tablet at its next sync (`pos_devices` is pulled).
  - Deactivating ends the till's key and refuses the till being set up again. It does not stop a
    tablet that is signed in: the tablet drops the refused key and carries on, selling and syncing,
    under the login signed in on it (`ApiClient.authed`), until it is signed out or that login is
    switched off. The server takes a sale from a deactivated till, so nothing is trapped. This is what
    deactivating in `/admin` has always done; the page and its confirmation say so, say when the till
    has its day open, and say that a lost tablet is stopped by switching off its login under Staff.
    (The design first said "the tablet goes back to its sign-in": read in the till's code, it does not.)
  - The owner of a business can reactivate a till, including one deactivated in `/admin`. The API's
    "Contact EasyPay to reactivate it" becomes "Reactivate it in the back office, under Point of sale".
- **Cash flow.** *History*: the days this till closed on a chosen date (today to begin with): opening
  float, cash in and out, counted at close, variance, and what did not go in the drawer by payment
  method. Under each, EasyPay's drawer line by line with what it held after each line, folded away.
  When the day is open, what the drawer should hold now comes first. *Movements*: every payment in
  and out of the till over a from-to range: inflows (date, by, method, receipt, amount) and outflows
  (date, by, method, amount, type, comment), each with its total. Cash put in and paid out are there
  too. The latest 500 of each, and the page says when there were more.
- **Traceability.** Everything the till did over a from-to range (today to begin with), newest
  first, grouped by day under a band with the day written out: a round icon for each event, its name,
  its detail, who, and its time large on the right. Events: day opened, day closed, sale, refund,
  cash in, cash out, drawer opened with no sale, drawer counted, clocked in and out, app stopped. A
  line that reached the server late says so. The latest 1,000, and the page says when there were more.

## What goes, and what is left out

- The page of every till's activity on one day goes: each till has its own.
- "Drawers open now" goes: the cards say what each drawer should hold.
- Left out of this piece, as agreed: the power-off key and cash out (piece 2). Left out for good unless
  asked: closing a month, the back office as a till, "takes payments", POS rules, a CSV of cash-ups,
  the events EasyPay's tills do not send (terminal started, operator signed in, version changed).

## How it is drawn

In EasyPay's own stylesheet, both looks: every colour a name with a light and a dark value, no colour
in a rule or in a page. Worded for a shop as for a restaurant.

## How it is checked

- `web/lib/pos.test.mjs`: where an old address goes, the variance in words, the timeline by day, the
  movements split in and out.
- `db/tests/pos-pages.test.cjs`, on a day made the way a till makes it: cash-ups, taken today by
  method, the days of a till, the closures of a date, the movements, the events over a range; and the
  pages themselves drawn for the probe business, a shop and a role with no reports; rename and
  deactivate through the page's own actions.
- `db/tests/shop-pages.test.cjs`: the new addresses in place of the old.
- The pages drawn from dev's rows to HTML and looked at in both looks.

Not seen by me: the pages behind a real sign-in, and a tablet taking a new name or being deactivated.
