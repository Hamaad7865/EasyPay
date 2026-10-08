# Kitchen screen on a second tablet, and the premium tier: design

Date: 2026-10-09. Status: the decisions in section 2 were made by the user in conversation; the rest is the design that follows from them, waiting for the user's review. No code written yet.

## 1. Purpose

Two things, asked for together on 2026-10-08:

1. **Premium.** For restaurants, the kitchen display and Bookings become part of the premium tier. The plan label the platform admin already sets (`tenants.plan`) starts to mean something.
2. **A kitchen screen on another tablet.** The restaurant has a till, and a tablet in the kitchen that shows each order the moment Send to kitchen is pressed, with its kitchen order number. What each screen shows is configurable.

What exists today: the kitchen display is built, but only on the till's own tablet. A send's ticket and its K number are made on that tablet (`Kitchen.prepare`, `KdsTicketEntity`); the server keeps only each line's kitchen status (`kitchen.mark`); a pull does not hand open orders to another tablet. So the display is ready and the link between two tablets is what is missing.

The behaviour reference is Lightspeed K-Series, Kitchen Display System 2.0 (read 2026-10-09): a screen is given a name, the items routed to it, what a ticket shows and the minutes after which a ticket is late; its screens are fed by a till on the local network. EasyPay keeps its own name, wording and look.

## 2. Decisions the user made

| Question | Answer |
|---|---|
| How an order reaches the kitchen tablet | Over the restaurant's own Wi-Fi, till to tablet. Not through our server, not Firebase. |
| Why | It works with the internet down, costs nothing a month, and should be well under a second. |
| Which app runs on the kitchen tablet | The same APK. The first screen offers "Set up as a kitchen screen". |
| Login on the kitchen tablet | None. It sends our server nothing about the restaurant. (It does ask whether a newer EasyPay exists, section 4.2; that was added by this design.) |
| How the till knows the tablet | Its address and a pairing code, typed in the back office under Printers as a kitchen screen. |
| What is configurable | Which items a screen shows; when a ticket turns late; what a ticket shows; sound and display. |
| What a Standard restaurant keeps | Send to kitchen and printed kitchen tickets. The Kitchen tab on the till, the kitchen screen and Bookings are premium. |

## 3. Premium

**Where it lives.** `tenants.plan`: `trial`, `standard` or `premium`, set by the platform admin in `/admin`, as today. Premium features are on for `premium` and for `trial`, so that a restaurant trying EasyPay sees all of it. (The trial rule is this design's proposal, section 9.)

**How it reaches the back office.** `tenantContext()` already joins `tenants` for the business type; it carries the plan the same way.

**How it reaches the till.** As the business type does: `platform.set_tenant_plan` and `platform.create_tenant` write `pos_settings.data.plan` in the same transaction, and a migration fills it in for every existing tenant. The till reads it loosely (`PosSettings.premium`). A missing key means "as before", like every other key: the till shows the screens it always showed. Once the migration has run, every tenant's settings carry the key and the gate applies to all of them; before it has, a new till build installed early takes nothing away. `tenants.plan` stays the one source of truth; the back office's settings save merges keys and never sends this one.

**What changes for a restaurant that is not premium.**

| Place | Change |
|---|---|
| Till | The Kitchen and Bookings entries, and their badges, are not shown. Send to kitchen, kitchen printing, void and reprint tickets are as they were. A takeaway is moved to Ready with the board's own "Mark ready" key, which exists today. |
| Till | Nothing is sent to a kitchen screen. |
| Till Help | The entries about the kitchen display and bookings are left out. |
| Back office | Bookings is not in the side menu or the search, its page refuses a direct visit and says it is part of Premium, and the dashboard's booking cards are left out. |
| Back office | Printers does not offer "Kitchen screen"; kitchen screens already entered are listed as switched off by the plan. |
| Server | `booking.upsert` from a till, and the back office's booking saves, are refused with a code of their own (`not-premium`). A kitchen screen cannot be saved. |

Nothing is deleted when a plan goes down: bookings and kitchen screens stay in the database and come back with the plan.

Shops are not touched: they have neither a kitchen nor bookings.

**Every restaurant that exists today becomes Standard.** A tenant is made `standard` unless the admin chose otherwise (and the column's first default was `free`), so the day the gate goes live every current restaurant, the demo ones on dev included, loses its Kitchen tab and Bookings until the platform admin sets it to premium. The admin page says, beside the plan, what Premium switches on.

**An item that reaches no one.** Today a line whose category has no kitchen printer is still marked as sent, on the grounds that it is on the kitchen display. A Standard restaurant has no kitchen display, so that line would reach nobody and nobody would be told. For a restaurant without the Kitchen tab, Send therefore names the items that went to no printer ("2 items went to no printer: Soft drinks. Tick a printer for their category in the back office.").

**Old tills.** A till below the first build that knows the plan still shows Kitchen and Bookings, and a booking it makes for a Standard restaurant would be refused by the server. So the server's refusal goes live together with `MIN_TILL_VERSION` raised to that build: an older till is told to update and keeps its sales until it has. That deploy step is the owner's.

## 4. The kitchen screen

### 4.1 Who talks to whom

```
 till (tablet A)  ── Wi-Fi, one short exchange at a time ──▶  kitchen tablet (tablet B)
   makes the order, the K number,                               listens, shows, keeps what it was sent,
   decides which lines go to which screen,                      records ticks and bumps
   keeps asking for what the cooks did   ◀── the answer ──
   tells the server (kitchen.mark), as today
```

The till always opens the connection, as it does to a printer. The kitchen tablet only answers. The till stays the one place that knows the order and tells the server; nothing about the server's kitchen ops changes.

### 4.2 Setting up a kitchen tablet

1. EasyPay is installed. The sign-in screen has a second key, **Set up as a kitchen screen**.
2. Pressed, the tablet remembers it is a kitchen screen (`SessionStore`) and from then on opens straight on the kitchen display (`Routes.KDS`, reserved for this since the first build).
3. Until a till has spoken to it, it shows a waiting page: its address on the Wi-Fi, its pairing code (made once on the tablet, eight letters and digits that cannot be mistaken for one another), and one line saying where to type them.
4. A kitchen tablet has no menu, no cash, no PINs and no sales. Its settings (section 4.8) include "Use this tablet as a till instead", behind a question; it clears what the tablet was sent.

The kitchen tablet keeps its screen on while the display is open.

**Updates.** A kitchen tablet is offered a newer EasyPay the way a till is: it asks `GET /health`, which needs no login and does not touch the database, and shows the same update key. Without this it could only be updated by hand, and section 6 tells people to update it.

### 4.3 Back office: a kitchen screen under Printers

Printers gets a third kind beside Network and USB: **Kitchen screen**. Its form holds a name ("Grill"), the address and the pairing code the tablet shows, **Shows: everything / only the categories ticked for it**, and On/Off. Paper size, feed and cut are not asked. The Categories page lists kitchen screens beside the printers in each category's ticks, as it lists printers today.

Stored in `printers`: `kind` may be `'screen'`; two new columns, `pair_code` and `all_items`.

A kitchen screen is never the receipt printer. Today a store's first printer is made its receipt printer, and any printer can be chosen as one (`web/lib/saves.ts`); both rules leave screens out, so a restaurant that enters its kitchen screen before its printer does not end up with receipts sent to the kitchen.

**Old tills.** A till up to 0.5.1 keeps a printer's kind as whatever text it was sent and treats anything that is not USB as a network printer. Handed a kitchen screen, it would list it as a station and send printer bytes to the tablet on every send, with a "not answering" each time. So: the new build keeps screens out of everything that prints (`Printing.printers()` is paper only); and in production the first kitchen screen is entered only once `MIN_TILL_VERSION` has been raised to that build, the same step as the premium gate. The Printers page says so beside the option. On dev, a till still on 0.5.1 (the owner's emulator) shows exactly this until it is updated.

### 4.4 Which lines go to which screen

`Routing` keeps its place as the one rule, and gains the screens:

- Paper is worked out from printers that are not screens, exactly as today, "one printer for everything" included.
- A screen set to **everything** gets every line of a send. A screen set to **ticked categories** gets the lines whose category ticks it. A send with nothing for a screen sends it nothing.
- A restaurant can have paper and a screen for the same category, a screen alone, or several screens.
- On the till's own Kitchen tab every kitchen screen is a station, whatever it is set to show: one set to everything lists every line, and with "one printer for everything" the screens are the only stations. Paper stations are worked out as today.

The part of a send that goes to one screen is frozen when it is sent (its lines, names and details as sent), so a later change to the routing or the menu does not rewrite what the kitchen was shown.

### 4.5 The link

One exchange: the till connects to the screen's address (port 9310 unless the address names another), writes one line of JSON and a second line holding its signature, reads one line of JSON, and closes. Plain sockets, as for printers.

The till sends:

- `v`: the link's version, 1.
- `till`: this till's device id and name.
- `put`: ticket parts the screen has not confirmed yet. Each: the kitchen ticket's id, K number, label (table or order number), order type, covers, waiter, remark, time sent, and its lines (id, quantity, name, detail).
- `marks`: what changed on the till since the screen last confirmed: a line voided, a line done or not done, a ticket bumped or recalled from the till's Kitchen tab.
- `after`: the number of the last change of the screen's that the till has taken.

The screen applies them and answers:

- `ok`, its EasyPay build, and `epoch`: an id made when the tablet was set up as a kitchen screen.
- `seq` and `marks`: what the cooks did since `after`, for this till's tickets only: a line done or not done, a part bumped or recalled.
- `have`: the ids of this till's tickets it holds.

Rules that make it safe to repeat:

- A `put` with an id the screen holds replaces it. Sending twice never makes two tickets.
- Marks say what a thing is now (done: true), never "flip it".
- A changed `epoch` means the tablet was set up afresh: the till starts again from zero and sends every open part again. A part missing from `have` is sent again.
- **Signature:** HMAC-SHA256 of the first line, keyed with the pairing code. The screen answers nothing but "refused" to a line whose signature is wrong, and the code itself is never sent over the Wi-Fi (it reaches each till from the back office with the normal sync, over HTTPS). This keeps out someone who only knows the address. It is not proof against a determined person on the same Wi-Fi; guests belong on a separate guest network, which is also true of the printers.
- A version the other side does not know is refused with words that say which tablet to update.

### 4.6 Sending, and when the kitchen tablet does not answer

- Send to kitchen never waits for a screen, as it never waits for a printer. The parts are written down on the till (a new table, `kds_parts`: kitchen ticket, screen, what was sent, delivered or not, bumped or not) in the same transaction that marks the lines sent, and the till tries at once.
- An undelivered part is tried again every few seconds without anyone asking; because a put cannot duplicate, this is safe where a reprint on paper is not.
- While a part waits, the till says so: the Send result names the screen ("Grill screen is not answering. Check that the kitchen tablet is on and on the same Wi-Fi."), it is kept under Settings, Notifications, and Settings, Printers shows each kitchen screen as answering or not, with how many orders wait for it.
- The order is on the till's own Kitchen tab the whole time, and on paper where a printer is ticked.
- While this till has open tickets on a screen it exchanges with it every 3 seconds, otherwise every 15, so that a tick or a bump reaches the till within a few seconds. This is Wi-Fi traffic inside the building; it reaches neither the internet nor our database.
- Settings, Printers has **Test** for a kitchen screen: the till says whether it answered, refused the code, or needs updating.

### 4.7 Ticks, bumps, recall, voids

- **A cook taps a line.** The screen shows it done at once; the till takes the mark at its next exchange, shows it on its own Kitchen tab and tells the server (`kitchen.mark`), as a tap on the till's tab does today.
- **Bump on a screen** takes that screen's part off that screen. Another screen's part of the same send stays where it is. The kitchen ticket leaves the till's Kitchen tab, and a takeaway moves to Ready, when every part of it has been bumped. Lines that went to no screen do not hold it back. A ticket with no part on any screen is bumped from the till's tab, as today.
- **Recall last** on a screen brings back the part that screen bumped last; the till puts the ticket back on its tab and a takeaway back to "In the kitchen".
- **Bump or recall on the till's Kitchen tab** acts on the whole ticket and is sent to every screen that has a part of it.
- **A void of a sent line** reaches the screen as a mark: the line is shown struck through with VOID, never silently removed. The VOID paper prints as today.
- **Reprint** is paper only.
- A table moved or merged after a send does not relabel what the kitchen already has, on a screen as on paper.

### 4.8 The kitchen tablet's own settings

Set on the kitchen tablet, kept on it, one set per screen:

| Setting | Choices | Default |
|---|---|---|
| A ticket turns amber after | minutes | 8 |
| A ticket turns red after | minutes | 15 |
| A ticket shows | covers, waiter, order type, remark: each on or off (the table or order number and the items always show) | all on |
| Sound when an order arrives | on, off | on |
| Text size | normal, large | normal |
| Light or dark | | dark |
| Language | as the till's | English |
| Pairing code | shown; "Make a new code" | |
| Use this tablet as a till instead | behind a question | |

The till's own Kitchen tab gets the same late minutes and "a ticket shows" settings behind a small settings key; its sound stays the back office's POS setting, as today.

### 4.9 What the kitchen tablet keeps

Its own small database (`kitchen.db`, apart from the till's): the tickets and lines it was sent, and a numbered list of what the cooks did. A kitchen tablet that is switched off and on shows what it showed. Tickets from days gone by are cleared as the till's are (three days). The header shows the screen's name as the back office has it, how many tickets are open and late, and whether a till has been heard from lately ("Terminal 01 · 2 s ago" or "No till for 2 min").

A ticket's age on the kitchen tablet is counted from when that tablet received it, on its own clock: two tablets' clocks drift apart, and a ticket must not arrive already late.

Two tills may send to one screen. Each takes back only the marks for its own tickets. Their K numbers count separately, so with two tills a ticket's number is shown with its till's code in front.

## 5. Where the code goes

| Unit | What it does | Depends on |
|---|---|---|
| `core/kitchen/Wire.kt` | The messages, their JSON, the signature. Plain Kotlin. | nothing of Android |
| `core/kitchen/ScreenServer.kt` | Listens, checks the signature, hands a message to the store, answers. | Wire, a store interface |
| `core/kitchen/ScreenStore.kt` | `kitchen.db`: tickets, lines, marks; applies a message, answers what changed. | Room |
| `core/kitchen/ScreenLink.kt` | Till side: the parts waiting, the exchanges, applying the screen's marks through `Kitchen`. | Wire, `Kitchen`, `TillDatabase` |
| `core/data/Routing.kt` | Gains the screens' rule. | as today |
| `core/data/Kitchen.kt` | Bump and recall learn about parts; marks set a state. | as today |
| `feature/kds/Kds.kt` | The display takes what it shows and what a tap does from outside, so the till's tab and the kitchen tablet use one screen. | two view models |
| `feature/kds/KitchenMode.kt` | The kitchen tablet: waiting page, display, settings. | ScreenServer, ScreenStore |
| `feature/auth`, `app/AppNav.kt` | "Set up as a kitchen screen"; open on the kitchen display. | SessionStore |
| `web/app/backoffice/printers`, `categories`, `bookings`, `nav.ts`, `lib/tenant.ts` | The kitchen screen form, the ticks, the plan in the shell. | |
| `db/migrations/0085`, `0086` | The plan in the settings and the refusals; `printers` for screens. | built from the live functions |

The till's own database goes to version 11: `printers.pair_code`, `printers.all_items`, the table `kds_parts`, added in place.

## 6. What goes wrong, and what is said

| Case | What happens |
|---|---|
| Kitchen tablet off, asleep, out of the app, or off the Wi-Fi | The till says the screen is not answering and how many orders wait; it keeps trying; they arrive when it is back. |
| Wrong pairing code | "Grill screen refused the code. Check the code in the back office, under Printers." |
| The kitchen tablet's address changed | Not answering. The waiting page and the settings show the address it has now. The router should keep it fixed, as for a printer. |
| Kitchen tablet reinstalled or set up afresh | New epoch: every open part is sent again. |
| The till restarts | Its parts and what it had taken are on the tablet; it carries on. |
| The two tablets on different EasyPay builds | The link's version decides: the same version works across builds; otherwise each says which one to update. |
| The Wi-Fi does not let tablets talk to each other (guest isolation) | Not answering. Set-up notes say the till, the printers and the kitchen tablet go on the same, staff, network. |
| The plan goes from premium to standard | The till stops sending to screens and hides the tabs at its next sync; a kitchen tablet goes quiet. |

## 7. Testing

Written first, on the JVM, with no tablet:

- `Wire`: a message out and back; a wrong signature refused; an unknown version refused.
- `Routing`: everything, ticked categories, paper and screen together, one printer for everything with a screen, a line with no screen.
- Parts: a ticket with two parts is bumped only when both are; a recall on one brings it back; a ticket with no part behaves as today.
- A loopback test: `ScreenServer` and the till side talking over 127.0.0.1: a put twice is one ticket, marks both ways, a new epoch, a silent server and its retry.
- `PosSettings.premium`: premium, trial, standard, missing.

Database suites on dev: the plan written into the settings by a plan change and by a new tenant; `booking.upsert` refused for standard and taken for premium and trial; a kitchen screen refused for standard, and never the receipt printer; the suites nearest `sync_push` run again. The suites that make bookings today (`service-v2`, `backoffice-saves` and any other that does) make their tenant premium first; they would otherwise fail on the new refusal.

On the till: Send for a restaurant without the Kitchen tab names the lines that reached no printer.

On emulators: the test emulator as the till and a second one as the kitchen tablet, joined through the PC (`adb forward`), for the whole path: set-up, a send, a tick, a bump, a recall, a void, the tablet switched off and on.

Not something Claude can test: two real tablets on a real restaurant Wi-Fi. That is the owner's first trial, and the design's "well under a second" is its promise until then.

## 8. Build order

1. **Premium gate.** Migration 0085, the back office, the till. Small, and useful on its own.
2. **Kitchen screen.** Migration 0086 and the back office form; `core/kitchen` with its tests; the kitchen tablet's mode; the till side; Help; the till's version raised.

Each is its own plan (`docs/superpowers/plans/2026-10-09-premium-gate.md`, `2026-10-09-kitchen-screen.md`). On dev the gate lands first. Production gets both together, in this order, each on the owner's word: the restaurants that keep Bookings and the Kitchen tab set to Premium in `/admin`; the migrations; the back office; the till release; the till API with `MIN_TILL_VERSION` raised. The gate alone would refuse the bookings of tills on 0.5.1.

## 9. Decisions this design took, for the owner to confirm or overrule

- A **trial** restaurant has the premium features.
- The **late minutes and what a ticket shows** are set on each kitchen tablet, not in the back office. Which items a screen shows is set in the back office.
- **Bump on a screen** clears that screen's part only; the order is "ready" when every screen has bumped its part.
- The pairing code is **eight characters, typed once** in the back office.
- Turning the gate on in production, and entering the first kitchen screen there, goes with **requiring the new till build**.
- **Every existing restaurant becomes Standard** until the admin sets it to premium.
- The kitchen tablet **asks our server whether a newer EasyPay exists**, and nothing else.

## 10. Not in this build

- Orders reaching the kitchen through the internet (Firebase or our server). It would be wanted for QR table ordering and for tills sharing orders, and is a design of its own.
- The till finding the kitchen tablet by itself, with no address typed.
- A kitchen screen in a browser or on a television.
- Statuses beyond done and bumped; a preparation-time report; filtering a screen by floor or by till.
- Keeping the kitchen tablet listening while another app is in front.
- What premium costs, and the public site's wording about it.
