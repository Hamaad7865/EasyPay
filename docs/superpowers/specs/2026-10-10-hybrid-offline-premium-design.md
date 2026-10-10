# EasyPay as a hybrid: an offline edition and Premium (the overall plan)

Asked 2026-10-10: "We need to have a good planning on this software, I want this software to be hybrid,
because I'm going to sell it as an offline thing, if the customer wishes to upgrade to the premium plan,
then he needs to pay a monthly fee of 2100rs or a whole thing annually. How can we do this? Let's get a
solid plan first".

This document is the plan for the whole change. It is too large for one build: section 7 cuts it into
eight pieces, and each piece gets its own design and its own build plan before any of its code.

The owner's answers, the same day, each a choice among options put to them:

- What the offline edition is: **"Tablet alone"**. The tablet holds everything; no account on our
  server, no back office, no hosting cost. They did not take "Tablet alone + online backup".
- How a tablet is unlocked: **"Code, checked online once"**.
- What only Premium has, besides the cloud itself: **the kitchen screen and Bookings**. Shop stock tools
  and full reports were offered for Premium too and left out, so the offline tablet must have both.
- What a payment covers: **"Per tablet, then per store"**. One fee unlocks one tablet for good; Premium
  covers one store with all its tills and kitchen screens.
- When Premium runs out: **"Reminders, 7 days' grace, then offline"**.
- On the plan as a whole: **"Start with 8 first"** (the shop's stock tools on the tablet).

## 1. What there is today

Read in the code that day:

- **Selling already runs on the tablet.** 26 kinds of change (a sale, a refund, cash in and out, opening
  and closing a day, a booking, a customer, a price) are written to the tablet's own database and queued
  for the server. The tablet moves its own count of stock at each sale (`moveStock`).
- **Ten kinds of change wait for the server** and so need a connection: `item.save`, `item.remove`,
  `category.save`, `category.remove`, `printer.save`, `company.save`, `staff.save`, `staff.set_pin`,
  `stock.adjust`, `tables.add`. All ten go through one function, `ask()` in `core/data/Service.kt`.
- **A tablet cannot start without the server.** The first sign-in is an e-mail and a password checked by
  the hosted sign-in service; the store, the till's registration and the whole catalogue come from the
  server. A new client's payment types, roles, taxes and order types are made by the server
  (`platform.create_tenant`).
- **The tablet's database already has the tables** for taxes, discounts, add-ons, roles, payment types
  and variants. It has no screens that change them.
- **Only in the web back office:** taxes, discounts, add-ons, roles, receipt design, product import,
  every report and insight, purchase orders, suppliers, stock counts, the stock history, time cards.
- **Every client's data is on Neon**, whose hours are paid by the month, against a fee paid once.
- **The plan a client is on** (`tenants.plan`: trial, standard, premium) hides the kitchen screen and
  Bookings from a Standard restaurant (migration 0085). It has no date and no payment behind it.

## 2. The two editions

| | Offline (paid once, per tablet) | Premium (per store, by the month or a year in advance) |
|---|---|---|
| Where the data lives | On the tablet only | On the tablet and in the cloud |
| Internet | One minute at set-up | For sync; selling works through a cut, as today |
| Menu, staff, printers, tables | On the tablet | On the tablet or in the web back office |
| Reports and the shop's stock tools | On the tablet | On the tablet or the web, from anywhere |
| Several tills sharing one menu and one set of sales | No | Yes |
| Kitchen screen, Bookings | No | Yes |
| Backup | A file the owner saves to a USB stick or to their Drive | Automatic |

Every customer buys the offline licence, and Premium sits on top of it. A customer who stops paying
falls back to something they own; nobody is locked out of their own sales.

Two offline tablets in one shop do not know each other: each has its own menu and its own sales. A
second till that shares is a reason to take Premium.

## 3. Licences and payments in /admin

- **Every customer is a client in /admin from the day of the sale**, as today. An offline client has no
  data on the server: a name, restaurant or shop, and its tablets.
- **"Add a tablet" gives a code.** At first start the tablet sends the code and receives a licence tied
  to itself: the client, the store and the till it is, and our signature over them, which the app
  checks with a key it carries. After that it never needs the internet. Because the licence names the
  client, the store and the till, what an offline tablet writes is already numbered as a cloud client's
  rows would be, which is what makes section 6 simple.
- **"Move to another tablet"** frees the code for a replacement. When a tablet happens to be online it
  looks for an update, and in the same breath for the short list of licences that were moved. That list
  is a small file, not a question to the database: a Neon project stays awake five minutes each time it
  is woken, and a hundred tablets asking once a day would spend most of a project's free hours.
- **"Record a payment"** for Premium: one month, twelve, or any number, and the amount received. It
  moves the store's paid-until date. The list of clients shows who runs out soonest.
- **No online payment.** The owner collects as they do today and records it. A payment gateway is a
  separate project.

The lock keeps honest customers honest and no more: the repository is public, so anyone can read the
code and build the app without it. Making the repository private is the owner's decision; the tablets'
update download depends on it being readable today.

## 4. The tablet alone

- **One seam.** The ten changes of section 1 get a second way of being answered. On a Premium till
  `ask()` goes to the server, exactly as today, so what is released and working is not disturbed. On an
  offline tablet the tablet applies the change to its own database, by the same rules written in
  Kotlin and tested on the JVM. The screens above do not know which it was.
- **The 26 queued changes** are already applied on the tablet first. On an offline tablet they are
  simply not sent.
- **First start:** the code instead of an e-mail and a password. The tablet then makes what the server
  makes for a new client (payment types, roles, VAT, order types) and opens the set-up steps that exist
  (something to sell, tables, a printer, staff and PINs, business details).
- **Nothing of sync is shown:** no sync key, no "not sent yet", no rejected list.
- **Backup:** the owner saves the tablet's data as one file, to a USB stick or through Android's own
  share sheet, and a tablet being set up can be filled from such a file. The till reminds when the last
  backup is old. This is the offline customer's only protection against a broken tablet, so no offline
  tablet is sold before it exists.

## 5. Premium by date

- A store has a **paid-until date**. `has_premium` (0085) asks the date as well as the plan, so the
  server refuses what the till would refuse.
- The date travels to the tills in the settings they already pull, as the plan does today.
- **Each till knows the date itself**, so the reminder (from 7 days before), the 7 days' grace and the
  drop happen with no internet. The last time the server was heard is the floor for "now": setting the
  tablet's clock back does not extend anything.
- The web back office shows the same reminder, and after the grace becomes read-only: its pages open
  and export, nothing is saved.
- **"Trial"** becomes a paid-until date with no payment behind it.

## 6. Going Premium, lapsing, coming back

A tablet is in one of two states: **alone** (section 4) or **linked** (today's till).

- **Going Premium (alone to linked):** the owner signs in on the tablet with the login made for them in
  /admin. The tablet sends up what it holds once, the "lift": its menu and set-up, then its sales. From
  then on it syncs as a till does today. Further tills join by signing in.
- **Lapse (linked to alone):** after the grace each till sends what it still can, then carries on alone
  with everything it holds. The cloud's copy stays where it is, read-only.
- **Coming back (alone to linked again):** the owner records the payment. The lift runs again: the menu
  and set-up from the one till the customer names, the sales made meanwhile from every till. A store
  with one till has nothing to choose.

The lift is the only new way data moves. How much history it carries is for its own design: a Neon
project holds 1 GB, and a busy shop's years of receipts should not all go up.

## 7. The pieces

Each is designed, planned, built and released by itself. Sizes are estimates.

| # | Piece | Size |
|---|---|---|
| 8 | **The shop's stock tools on the tablet:** suppliers, purchase orders and deliveries, stock counts, the stock history | Large |
| 1 | **Premium by date:** the paid-until date, payments recorded in /admin, reminders, grace, the read-only back office | Small |
| 2 | **Licence and unlocking:** clients with tablets and codes in /admin, the code screen, the signed licence, moving one | Small |
| 3 | **Tablet alone, core:** the ten changes answered on the tablet, first start, sync out of sight | Large |
| 4 | **Backup and restore** | Small |
| 5 | **The rest of set-up on the tablet:** taxes, discounts, add-ons, roles, receipt design, product import | Medium to large |
| 6 | **Going Premium and coming back:** the lift, the lapse, the return | Large |
| 7 | **Reports on the tablet** | Medium |

The order is the owner's: **8 first**. The numbers are those of the first list they saw; after 8 the
rest follow as listed unless they say otherwise.

- Piece 8 comes before the tablet can stand alone, so its screens first serve the shops whose tills are
  linked today. How it is built so that the same screens serve an offline tablet later is its own
  design's first question.
- Piece 1 turns today's cloud product into Premium that can be charged for; it depends on nothing else.
- The offline edition can be sold after pieces 2, 3 and 4, with what the tablet can change today. Until
  piece 5 an offline restaurant cannot add an add-on or change the VAT rate.

## 8. What I decided and the owner has not confirmed

- Every customer buys the offline licence first, and Premium is on top (section 2).
- Premium tills keep today's path, with the server as the authority; an offline tablet is its own
  authority (section 4). One engine for both was weighed and left: it would change the released path,
  and a change queued on one till and refused later (a barcode another product holds) takes the sales
  that used it down with it, which is why a product is not queued today.
- A client in /admin for every customer, and a licence that carries its ids (section 3).
- Payments are recorded by hand (section 3).
- A moved licence is learned from a file, not from the database (section 3).

## 9. Not said yet, the owner's to say

- **The annual price.** Nothing in the build needs it: /admin takes any number of months and any
  amount.
- **The offline price.** Rs 5,000 is the fee clients pay today; that it stays the offline edition's
  price is my reading.
- **Clients already on the cloud** (Star Grill, a Standard restaurant): they stay as they are until the
  owner decides. Piece 1 must not switch anything off for them by itself.
- **Whether the repository becomes private** (section 3).

## 10. Outside this plan

- A payment gateway, invoices, receipts for subscriptions.
- A trial of the offline edition (a code that ends by itself).
- Two offline tablets sharing over the shop's own Wi-Fi with no cloud (the spec's "LAN hub").
- MRA e-invoicing. It is not built. The spec plans it as a job sent when the tablet is online, so a
  customer obliged to it will need the internet at times on either edition. MRA's current rules were
  not read for this plan.
- Spreading Premium clients over several Neon projects (`docs/superpowers/plans/2026-10-09-projects-*`):
  still needed once Premium clients outgrow one project's hours, less urgent once offline clients hold
  nothing on the server.
