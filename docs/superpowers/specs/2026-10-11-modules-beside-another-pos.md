# Another restaurant POS's modules, and where EasyPay stands on each

2026-10-11. The owner: "list all of their modules. So we will build them but leave the waiter app this is
overkill in mauritius". Read that day from that product's own site (home, Product, the eight feature pages) and from
the screenshots of their back office the site shows, whose side menu is the list below. What EasyPay has
was checked against `web/app/backoffice/nav.ts` and a search of the till's and the back office's code, not
from memory; where a thing was not checked it says so. Their site changes: read it again before quoting it. The product is not named here: this file is public.

**Built** = EasyPay has it. **Partly** = some of it. **Not built** = nothing of it.
**Bill** = it costs money every month to run (EasyPay's running costs are meant to stay near zero, so
each of these is the owner's to decide: Premium only, or not at all).

## Their back office, in the order of its menu

| Their page | What it is | EasyPay today |
|---|---|---|
| **Today** | The day at a glance; opens on a written brief | Partly. Dashboard: sales today, what needs attention, tables and orders right now, next bookings. No written brief. |
| **Counter** | | |
| Orders | Every order, open and closed, with its bill | Built. Order details and Receipts (reprint, refund). Open orders are as of each till's last sync. |
| Bookings | A diary; a guest is seated from it | Built (Premium), entered by staff. Booking online by the guest, with a code and a reminder on WhatsApp or e-mail: not built (**Bill**: WhatsApp). |
| Customers | Guests and what they ordered | Built. |
| Delivery: Riders live | Each rider on a map, deliveries, cash held | Not built. The till has a delivery board that gives an order to a member of staff. A live map may need paid maps (**Bill**). |
| Delivery: Busy mode and last orders | Stop or slow online orders per channel | Not built (there is no online ordering page). |
| Delivery: Delivery apps | Orders from delivery platforms | Not built. |
| Delivery: Riders' pay | What each rider is owed | Not built. |
| Menu | Dishes, sections, options, labels, allergens | Built: Items, Categories, Add-ons, Discounts. Allergens and dietary labels: not built. |
| **Finance and stock** | | |
| Insights: Sales | Takings, orders, guests against the period before | Built (Sales patterns). |
| Insights: Guests and tables | Covers, spend per guest, time at the table | Partly (covers and turn time are on Staff performance). |
| Insights: Kitchen and service | How long the kitchen and the service take | Not built. |
| Insights: Menu profit | Each dish's margin from its recipe cost, with suggested changes | Partly. A shop's products have a cost and a margin (Item sales). A dish has no recipe, so no cost. |
| Insights: Menu and stock | What sells and what does not | Built (Menu performance). |
| Insights: Team | Each person against the team | Built (Staff performance). |
| Finance: Overview | Takings, VAT, charges, discounts, how guests paid | Built (Sales summary). |
| Finance: Paid orders | Every paid order | Built (Order details, Receipts). |
| Finance: Payments | By method and by person | Built by method (Sales summary); by person not checked. |
| Finance: Refunds | Refunds as credit notes | Partly. Refunds are made from Receipts; there is no credit note. |
| Finance: Tips | Tips kept apart from takings | Not built. |
| Finance: Day by day | Daily totals | Not checked as a page of its own (Sales summary gives a range). |
| Finance: Till counts | Float, count against expected, every drawer opening | Built (Day closing; each till's cash flow). |
| Finance: VAT returns | VAT on sales for each return period | Partly. The Tax report gives any dates; it does not know the return periods. |
| Finance: Loss watch | Voids, discounts, refunds, short tills, each person against the team | Partly. Discounts and refunds per person are on Staff performance; voids and short tills per person are not. |
| Invoices | Invoices for catering and companies; tax invoices | Not built. |
| Stock: Prep plan | What the next service will sell, from the same weekday | Not built. |
| Stock: Inventory | Counts, deliveries, waste | Built for a shop (stock on hand, purchase orders, receiving, counts, movements, losses). A restaurant counts the stock of an item, no more. |
| Stock: Ingredients and suppliers | Ingredients, suppliers, recipes | Not built for a restaurant (a shop has suppliers). |
| **Admin** | | |
| Team: People | Each person's role and PIN | Built (Staff, Roles and permissions). |
| Team: Time clock | Clocking in at the restaurant only, timesheets, overtime, a payroll file | Partly. Clock in and out on the till, and Time cards. No overtime rules, no payroll file, no check of where the person is. |
| Setup: Tax and charges | Taxes, service charge | Built (Taxes; POS settings). |
| Setup: Payments and receipts | Payment types, the receipt | Built (POS settings; Receipt design). |
| Setup: Online and delivery | The online channels | Not built. |
| Setup: Table QR and bookings | Switches for ordering from the table | Built (Premium). |
| Setup: Your page | The restaurant's own public page | Not built. |
| Setup: Opening hours | When the place is open | Not built. |
| Tables: The room now | The room as it is this minute | Partly. The dashboard counts tables in use, as of the last sync; the room itself is on the till. |
| Tables: Waiters' tables | Which waiter has which tables | Left out with the waiter app. |
| Tables: Floor plan | Drawing the room | Built (the designer; its booths, walls and turning are built and not released). |
| Tables: QR codes | A code to print for each table | Built (Table cards, Premium). |
| Tables: Table by table | Each table's history | Not built. |
| Devices and printers: Devices | Every screen and who is on it | Built (Tills: a page per till, its activity, its cash). |
| Devices and printers: Printers and stations | Printers, and which station prints what | Built (Printers; kitchen and bar by category). |
| Security: Security | Sign-in and access rules | Partly (roles, a manager's PIN for what needs approving). No page of its own. |
| Security: Audit log | Every change, void, discount and refund, with who approved | Partly. It is recorded (each till's activity, approvals); the back office has no one page that shows it all. |

## What they have outside the back office

| Theirs | What it is | EasyPay today |
|---|---|---|
| Waiter app on phones | Orders at the table, each waiter's tables, alerts | **Left out**, at the owner's word. In EasyPay the order is taken on the till's tablet. |
| Counter (POS) | Sell, split a bill equally, by seat, by dish or by amount | Built on the tablet (seats, split check). Tips and vouchers: not built. |
| Kitchen display | Tickets by course and station, timers that change colour, allergens, ready per course, undo | Built (Premium), on a second tablet over the restaurant's Wi-Fi: stations, bump, recall. Ready per course, coloured timers and allergens: not built. Theirs also runs in a browser; ours is the tablet app. |
| Table QR ordering | The guest orders from the table onto the same bill | Built (Premium). Call a waiter and ask for the bill: not checked. |
| Pick-up and delivery page | Orders from the restaurant's own page | Not built. |
| Rider app | The rider's deliveries and cash | Not built. |
| Guest reviews | Collected on WhatsApp, each with its order and who served | Not built (**Bill**: WhatsApp). |
| AI assistant ("ask about anything, change the menu by chat") | A chat over the account | Not built (**Bill**: paid by the question). |
| AI brief | The day so far in a few lines | Not built. Can be written from plain figures, with no bill. |
| Seven-day forecast | Orders and sales for the week ahead | Not built. It is the same weekday over four weeks: arithmetic, no bill. |
| AI menu import | A menu read from photos, a PDF or Word | Not built (**Bill**: paid by the import). A shop imports products from Excel. |
| Recipes suggested from stock | AI proposes each dish's recipe | Not built (**Bill**). |
| Printers | Network and Bluetooth, drawer through the printer | Built, and USB too. Their cloud printing (CloudPRNT) is not ours. |
| Offline | Screens keep their last view; staff can clock in | **Ours is ahead**: EasyPay takes orders and payments with no internet. |
| Devices | iPhone, iPad, Android, any browser | Android tablets, and any browser for the back office. No iPhone or iPad app. |

## What EasyPay has that their menu does not

A shop's whole side (products, barcode labels, purchase orders, stock counts), the tablet that works with
no server at all (the offline edition), backup and restore, and prices in the open.
