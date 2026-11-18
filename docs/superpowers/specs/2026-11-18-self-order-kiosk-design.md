# Self-order kiosk — design

2026-11-18. Asked by the owner: "We're having customers that want to have kiosk now". Answers given by tap in the brainstorming session that day.

## Decisions (the owner's)

| Question | Answer |
|---|---|
| How the customer pays | **At the counter.** The kiosk takes the order and prints a numbered slip; the cashier takes the money. No card terminal. |
| When the kitchen gets it | **When the cashier takes payment.** Nothing is cooked for an order that is never paid. |
| Who gets it | **A paid extra, even for Premium.** Switched on per client in `/admin`; trial has it for demos. |
| Which businesses | **Restaurants only.** Shops never see it. |
| How it is built | **The EasyPay app on an Android kiosk**, set up as a kiosk, like the kitchen screen and the customer display. Big portrait screen ("like McDonald's"). |
| Hardware | **Android kiosks** (Sunmi K2-type, 21–32" portrait, often with a built-in printer). |

## 1. What the customer sees

Portrait only, laid out for 1080 × 1920. It is a new layout of its own. The till's screens (`ScreenFit`, at most 1067 × 600 dp landscape) are not stretched to fit.

1. **Welcome:** logo, an optional picture set by the owner, "Touch to order".
2. **Eat in / Take away:** the restaurant's dining options as big keys. All of them by default; the owner can untick some on the kiosk's row. With only one, this step is skipped. A kiosk order never carries a table. **To check when planning:** whether the till lets an order whose dining option needs a table be paid without one. If not, a kiosk order is let through.
3. **Menu:** categories down the left, large picture tiles (the products' pictures; a coloured tile when there is none). Sold-out items are greyed and cannot be tapped. Only items that are on sale at the till are shown.
4. **A dish:** the same options pop-up rules as the till (nothing preselected, Alone choices, add-ons one-or-none unless Several, see `restopos-options-in-popup`), drawn larger, with quantity − / +. Kitchen notes are not offered.
5. **Basket bar** along the bottom: count, total, "Start over", "Place order".
6. **Review:** lines with − / + / remove, total including VAT, "Place order".
7. **Done:** "Your number is **23**. Please pay at the counter." The slip prints, and Welcome comes back after 15 s.

60 s with no touch → "Still there?" for 15 s → the order is cleared and Welcome comes back. English only.

**The slip is not a receipt.** It shows the order number, dining option, lines, total and "NOT PAID — please pay at the counter". It has no bill number, nothing fiscal and no MRA. The till issues the receipt when the cashier is paid.

## 2. The kiosk and the till

**The link.** The kiosk talks to one till over the restaurant's Wi-Fi, signed the way the kitchen screen and the display are (`Wire.sign`, a port of its own). There is no server and no internet.
- The till sends the kiosk the menu (categories, items, prices, options, pictures, sold-out) when the kiosk connects and again whenever it changes.
- The kiosk sends an order; the till checks it against its own menu and prices (the kiosk's figures are never trusted), keeps it and answers with its number. **The slip prints only after that answer.** With no answer within 5 s, the kiosk says "Please order at the counter" and prints nothing.
- If the till cannot be reached, Welcome shows "Please order at the counter" and takes no order until the till answers again.

**Held apart from open orders.** A kiosk order is kept in a table of its own on the till (`kiosk_orders`: number, day, dining option, lines, total, placed at, status `waiting / taken / cancelled`). It is **not** a ticket, so it never blocks Close day and never syncs as a sale.
- **The kiosk key** on the till's top bar shows the count waiting, and a chime sounds on arrival (as the QR phone key does). The till also has a **Kiosk** tab in Orders. Each row shows number, time, lines, total and "Not paid".
- **Open** (from the list, or by typing the number) turns it into an ordinary new order on the till with its lines and dining option, and marks it `taken`. From then on it is an order like any other: the cashier can change it, then Pay.
- **Pay sends it to the kitchen**: an order that came from the kiosk is sent to the kitchen as part of a successful payment, by the same routing as Send to kitchen (printers or kitchen screen). If the payment fails, nothing is sent.
- **Cancel** (one tap, no reason) marks a waiting order `cancelled`. Nothing was cooked, and no money moved.
- **Numbers** start at 1 each trading day and are made by the till alone.
- **Day close** (by hand, and the day that closes itself, 0133) first cancels every `waiting` kiosk order of that day and counts them in the close ("Kiosk orders not paid: 3"). An order already `taken` is an ordinary order and follows today's rules.

## 3. Set-up, the paid extra, the tablet

**The paid extra.** The feature name is `kiosk`, held in `tenants.features` and set in `/admin` like `deposits` and `accounts`.
- `platform.set_tenant_features` accepts `kiosk` (its list of allowed names is fixed; 0114 has `deposits`, `accounts`).
- `has_feature(t, 'kiosk')` = plan is trial **or** `'kiosk' = any(features)`. **Premium does not carry it**, unlike deposits; the premium branch of `has_feature` must not cover it. The till's flag follows the same rule (`kioskPaid`, from `pos_settings.data.features` and `plan`), and does **not** copy `depositsPaid`.
- Restaurants only: a retail tenant never has it, even if the feature is set.
- **To check when planning:** how a paid extra reaches an offline-edition tablet that rarely syncs (deposits work offline, so the same path is used). The gate has to be visible on the till that the kiosk pairs with.

**Pairing.** A kiosk is a printer row of a new kind, `kiosk`, with `device_id` (the till it sends to) and an optional welcome picture. The next free migration number at build time (0160 today; check the other worktrees and branches first) re-adds `printers_kind_check` as 0130 did, and `printer.save` refuses kind `kiosk` without the feature, on the server, not only in the page.
- The kiosk's first screen offers **"Set up as a kiosk"** beside sign-in (as "Set up as a kitchen screen" does) and shows its address and a pairing code.
- Back office: **Printers → Kiosks**, Add with the code, choose the till, optional picture. An offline-edition till adds it in **Settings → Printers**, as with the display.
- Release: raise `MIN_TILL_VERSION` with it, or older tills list a kiosk as a printer that never answers.

**Printing.** The kiosk prints on a printer set on the kiosk itself, any kind EasyPay prints to today (network, USB, Bluetooth). **Not known until a real kiosk is in hand:** whether the kiosk's built-in printer is reachable as a USB ESC/POS printer or only through the maker's printer service. If it is the latter, that is a small extra piece, built only once a real kiosk shows the need.

**Runs itself: no one touches a kiosk in daily use** (the owner, 2026-11-18: "on power up of the kiosk the app should open automatically on all 4 kiosks" and "it should all work automatically, no human intervention should be needed").

**Set up once, by EasyPay, on install day.** Each kiosk is made **EasyPay's own device** (Android *device owner*), from a laptop with one command on a fresh kiosk (`adb shell dpm set-device-owner ...`), or by scanning a set-up QR code on the kiosk's first-start screen. Then it is paired with the till. This is the only time a person handles it, and it is ours, not the restaurant's.

**What the device owner lets EasyPay do alone, for good:**
- **Opens at power-up.** EasyPay is fixed as the kiosk's Home app by the app itself (no "Always" question), so every start, power cut or restart comes straight to Welcome.
- **Locked.** Full lock task, not screen pinning: no Home, Back, notifications, status bar or "unpin" message, and no way out for a customer.
- **Comes back by itself.** If the app stops, Android opens it again at once.
- **Screen always on** while plugged in; no sleep, no lock screen, no PIN at start.
- **No Android pop-ups.** System updates are held to a night window (02:00–04:00); nothing asks a question on the screen.
- **Connects by itself.** It finds its till on the Wi-Fi and reconnects after the Wi-Fi, the till or the kiosk restarts. Until the till answers it shows Welcome with "Ordering opens in a moment" and keeps trying. Once paired it never shows a sign-in or set-up screen.
- **Day by day without anyone.** Order numbers start again each day and waiting orders are cancelled at the day close (the day that closes itself, 0133, does it with no one).
- **Updates itself.** A new EasyPay version is installed by the app quietly at night (a device owner may install without asking), so kiosks never fall behind `MIN_TILL_VERSION`.

**For EasyPay's support only:** a long press in the top-left corner, then a manager's PIN, leaves kiosk mode (the lock is lifted and the normal Home comes back) and offers "Back to kiosk".

**Still needs a person, and cannot be avoided:** paper in the printer, the first install and pairing, and a broken or unplugged kiosk. When the printer reports no paper, the kiosk says "Please order at the counter" and the till shows "Kiosk 2: no paper", so staff know without looking.

**If a kiosk cannot be made device owner** (a maker's own management already holds it): EasyPay is the Home app instead (one "Always" tap on install day) with screen pinning and the maker's "start at boot" setting. This is a fallback; it is decided when the real kiosk is in hand.

**Several kiosks to one till.** Four kiosks (or any number) are four `kiosk` rows paired to the same till. The till makes every number, so they never give out the same number on one day.

## 4. Testing

- JVM rule tests: the till's check of an order against its menu and prices; numbering per day; answer-then-print; Open → order; Pay sends to the kitchen once and a failed Pay sends nothing; day close cancelling the waiting orders.
- A database suite: `kiosk` feature rules (trial yes, premium without the feature no, retail no, `bad-feature` gone for `kiosk`), and `printer.save` kind `kiosk` refused without it.
- On my own emulators (one portrait 1080 × 1920 as the kiosk, one till), following `restopos-emulator-is-shared`: pair, order, slip (to the stand-in printer), till chime and count, Open, Pay, kitchen, Cancel, day close, till switched off; the kiosk emulator, made device owner and restarted (`adb reboot`), comes back to Welcome by itself, locked, with no question asked; the app killed comes back; the till restarted and the kiosk reconnects alone; two kiosks ordering at once get different numbers.
- **Not testable here:** a real kiosk, its built-in printer, a real 21–32" touchscreen, whether the maker lets EasyPay be device owner, the quiet update on real hardware.

## Not in this piece

Card payment at the kiosk; French; upsell; customer name; kitchen notes; shops; a kiosk that works without a till nearby.
