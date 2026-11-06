# Premium Go live, like an offline tablet's (2026-11-06)

## What the owner asked

"The flow from setting up to go live is actually dog shit. Premium plan needs to have the go live like how offline
is. Say x customer, we imported his stocks 100 y. He made 2 test sales. When going live we need to remove the sales
and add back the stocks ... and remember everything should be in sync with the server."

Asked three things, the owner chose (all as recommended):

- Go live for a Premium client is pressed **on the tablet** (This till, owner only, like offline) **and in /admin**.
- /admin's Clear test activity **stops removing the tills**: it and Go live become one button.
- While a Premium client is set up, its tablets show the **TEST strip and print TEST / NOT A RECEIPT**, like offline.

## Why it was bad

- /admin had two buttons doing half each: **Clear test activity** deleted the trying *and removed every till*
  (each tablet then had to be wiped and set up again); **Go live** only took the client off the setting-up list.
- No till knew the business was being set up (`platform.setting_up` is not pulled), so none could offer Go live
  or mark its papers.
- Neither button told the tills to empty what they held.

## What was built

Server, migration `0157_premium_go_live.sql` (suite `db/tests/premium-go-live.test.cjs`):

- A trigger on `platform.setting_up` keeps `pos_settings.data.settingUp` true while a client is set up.
- `platform.go_live_clear`: what Clear test activity cleared (orders, receipts, refunds, payments, days, cash,
  clock-ins, approvals, bookings, credit notes, deposits, account bills, points), the stock put back by
  `platform.test_sales_on_stock` (a sale before a count stays out), bills numbered from 1. **Kept:** tills, keys,
  codes, device activity, the back office's requests to tills, and `sync_ops_applied` (a till re-sending a change is
  answered, never given it twice). Writes `cleared` (0155's mark: every till empties itself and pulls from nothing)
  and `live` (ms), takes the client off the setting-up list, and logs `tenant.live` with `cleared: true`.
- `business.go_live`, a new change through `sync_push`: the owner, or someone else with the owner's PIN
  (`approved_by`); refused `already-live`, `client-offline`, `forbidden`.
- `platform.go_live` (/admin): the same for a client in the cloud; unchanged for an offline one.
- `sync_push` drops a change of a rung-up kind (`db/tests/fixtures/go-live/rung-up.json` = the till's
  `GoLiveRules.RUNG_UP`) whose `at` is before `live`: answered `applied` with `dropped: before-go-live`. That is a
  test sale from a tablet that was off at Go live. A change with no `at` (an older till) is taken as before.
- `hello.ts`: a business with `live` takes push and pull only from build 50 or later (426, as for the MRA).

Tablet, till 0.9.38 (build 50):

- Every change sent says when it was made (`at`).
- `settingUpNow`: a tablet alone by its own flag (as before), a cloud business by the server's `settingUp`. The
  strip, the TEST papers and Go live follow it. Stock is noted for a put-back only on a tablet alone.
- Go live on a cloud business sends `business.go_live` (online, owner or owner's PIN). The pull after it, on this
  till and every other one, first drops queued rung-up changes made before `live` (`OfficeClear.dropBefore`), then
  empties the till as after Delete all transactions and pulls from nothing, so the stock comes back at 100.

/admin: one Go live card for a cloud client (the client's name typed), Clear test activity gone from the page
(the SQL function stays).

## My decisions, not asked

- The audit word stays `tenant.live` (with `cleared: true`), so /admin's log reads "Put live: 2 receipts and 2 orders
  cleared".
- `sync_ops_applied` and `till_requests` are kept, unlike Clear test activity.
- MRA records stay (as with Delete all transactions): an MRA client in training or live during setting up has sent
  those invoices.
- Tills older than build 50 of a business that went live this way are held (426) until updated, rather than Go live
  being refused while such a till exists.

## Not seen

- Any of it on a tablet or emulator, or in a browser. The suites ran on dev in rolled-back transactions.
