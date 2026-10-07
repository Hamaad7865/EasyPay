# Retail Stock module, step 3c: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline; this repo's owner is cost-sensitive, no subagent fan-out). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop counts its shelves, all of them or one category, supplier or brand, without closing: two people can count at once, the shop keeps selling, and completing the count puts every counted line right with one movement.

**Architecture:** One migration adds counts and their lines, and the functions that are the only way to count and to complete. A count is per shop and per line (a product, or one variant), unlike `stock_count_item`, which a restaurant's page keeps using on an item's total. Completing goes through the stock engine with the count as its document, so a count is applied once. The back office gains a Counts page and a count's own page, drawn from the approved board.

**Tech Stack:** Postgres on Neon (plpgsql, RLS), Node suites in `db/tests`, Next.js 16 back office in `web/`.

**Spec:** `docs/superpowers/specs/2026-10-07-retail-mode-design.md`, sections 5 (Counts) and 7, piece 3. Approved board: `Count` at https://claude.ai/artifact/GfTY9m9TFyXfNt5inwRh14. Read `2026-10-08-retail-stock-3a.md`, "Before starting", first: it applies here unchanged.

---

## What the till does with this

Nothing: none of the new tables is in the pull. A completed count reaches a till as the item's total, as any stock change does.

## Decisions made while planning (tell the user)

- **Which clock says "sold after it was counted".** A sale or a refund is judged by when it was rung up on the till (the receipt's own time), not by when it reached the server: a till that was offline sends its sales late, and a sale made before the shelf was counted is already missing from the shelf. Anything done in the back office (a delivery, an adjustment) is judged by when it was saved. **What this cannot cover:** a sale rung up before the count that only arrives after the count was completed still lowers the stock when it arrives. Complete a count once the tills have synced.
- **A product scanned that is not in the count's scope is added to the count**: it is on the shelf.
- **The review is on the count's page, beside the counting**, as on the approved board. While scanning, the expected figure of a line is not shown; the review shows it for the lines already counted.
- **"Delete all transactions" also removes counts.**

## Rules, each one a check in `db/tests/stock-counts.test.cjs`

| Check | Rule |
|---|---|
| N1 | A count of the whole shop has one line for every line of stock (a counted product, or each variant of one), none counted yet, and the tenant's next number (`C-0001`). A count of a category, a supplier or a brand has only their lines. A scope with nothing in it is refused (`nothing-to-count`). |
| N2 | A scan adds one to its line each time, whoever scans; typing sets the line to what was typed. Each keeps the time the line was last counted. A product outside the scope is added as a line. A product that is not a line of stock is refused (as for an adjustment). |
| N3 | The review gives each line what was expected, what was counted, the difference in units and in rupees at the line's average cost; a line is Different, Matching or Not counted. |
| N4 | A sale made after a line was counted is applied on top of the counted figure; a sale made before it was counted is already in what was on the shelf. |
| N5 | A sale rung up before the line was counted, and synced after, is not taken for a sale made after the count (the receipt's own time decides). |
| N6 | Completing writes one `count` movement per line that differs, with the count as its document; each line of stock then holds what was counted plus what moved after; the count keeps, for every line, what was expected, the difference and the cost. |
| N7 | Lines not counted: "leave" leaves them as they are, "zero" sets them to nothing. A line left out is not touched either way. |
| N8 | A completed or a cancelled count cannot be completed, counted on or changed, by the functions or by any statement on its lines (`count-closed`). |
| N9 | A line can be counted again from nothing (recount), and left out or put back. |
| N10 | A variant is counted on its own line; another shop's stock is untouched. |
| X1 | "Delete all transactions" removes the tenant's counts. |
| T1 | The tenant role can do all of it inside its own tenant, and sees no count of another. |

## File map

| File | Created or changed | What it holds |
|---|---|---|
| `db/migrations/00NN_stock_counts.sql` | create | `stock_counts`, `stock_count_lines`, `stock_moved_since`, `count_start`, `count_add`, `count_line`, `count_review`, `count_complete`, `count_cancel`, `purge_transactions` |
| `db/tests/stock-counts.test.cjs` | create | the checks above |
| `db/tests/require-dev.cjs`, backup `TABLES` | change | the two tables |
| `web/lib/counts.ts`, `counts.test.mjs` | create | a line's state in words, the review's totals (pure) |
| `web/app/backoffice/stock-counts/page.tsx` | create | the counts, New count |
| `web/app/backoffice/stock-counts/[id]/page.tsx`, `counting.tsx`, `actions.ts` | create | counting (scan or type) and the review (the `Count` board), Complete, Cancel; a completed count as a report |
| `web/app/backoffice/nav.ts`, `counts/route.ts`, `stock/on-hand.tsx` | change | the Counts link with how many are open; "New count" |

## The migration

One file. `stock_counts` (`store_id`, `number`, `scope_kind` all, category, supplier or brand, `scope_id`, `scope_text`, `title`, `status` open, completed or cancelled, `uncounted`, who and when) and `stock_count_lines` (`count_id`, `item_id`, `variant_id`, `counted`, `counted_at`, `left_out`, and what completing writes: `expected`, `diff`, `unit_cost`), both with the standard columns, RLS and `trg_touch`; a trigger on the lines refuses any change once the count is no longer open (the purge's way out as in `block_update`). `stock_moved_since(tenant, shop, item, variant, since)` is the clock rule in one place. `count_complete` locks the count's row, then each line of stock in a fixed order, and moves through `stock_move` with the count as the document. `purge_transactions` is redefined from 0074 with the two tables.

## Tasks

### Task 1: the suite, failing
- [ ] Write `db/tests/stock-counts.test.cjs` (one rolled-back transaction). Run it: `TEST_FAILED` on `function count_start(...) does not exist`.

### Task 2: the migration
- [ ] First free number; write it; migrate; the suite passes. Add the tables to `CHILD_FIRST` (lines before counts, at the head) and to the backup.
- [ ] One at a time: `purchase-orders`, `stock-adjust`, `stock-engine`, `stock-sales`, `stock-locks`, `pos-operations`, `isolation`. Commit.

### Task 3: a count in words
- [ ] `web/lib/counts.test.mjs` first, then `web/lib/counts.ts`. Commit.

### Task 4: the pages
- [ ] `stock-counts/page.tsx`: New count (the whole shop, a category, a supplier or a brand) and the counts with their state, how many lines are counted, and the difference of a completed one. `nav.ts`, `counts/route.ts`, "New count" on Stock on hand.
- [ ] `stock-counts/[id]/page.tsx`, `counting.tsx`, `actions.ts`: as the `Count` board. Counting: a box that takes a scan (each adds one, without loading the page again) or a name, then a quantity; the last lines counted. Review: Different, Matching, Not counted; Recount and Leave out on a line; what to do with the lines not counted; the net difference in units and at cost; Complete; Cancel. A completed count is read-only and prints.
- [ ] Type-check, `prepare-web-sql.cjs`, render, and the counting box in a browser on a temporary page. Commit.

### Task 5: see it
- [ ] Every suite, one at a time; build; the record at the end of this file.

---

## What happened when this plan was run (2026-10-08)

Built as written, with the differences below. Commits `780cf84` to `9d4d93b` on `restopos`, dev only, not pushed.

**As built:**

- Migration `0075_stock_counts.sql` and `db/tests/stock-counts.test.cjs` (37 checks). The suite is one transaction, in which `now()` does not move: its deliveries are dated two hours back and its first counted lines one hour back, so "after it was counted" means something. `count_add` stamps a line with the clock's own time for the same reason.
- `web/lib/counts.ts` with its node test.
- `/backoffice/stock-counts` (New count, of the whole shop or one category, supplier or brand that has lines of stock; the counts, with how far each is and what a completed one changed) and `/backoffice/stock-counts/<id>` (the scan box beside the review while it is open; a report that prints once completed). The Stock group has Counts, with how many are being counted; Stock on hand has "New count".

**Different from the plan:**

- **Migration `0076_count_scan_puts_back.sql`.** A line left out and then scanned stayed left out: completing would have thrown the scan away without a word. Counting a line now puts it back. Found by reading the page back; two checks in the suite, failing first.
- **The review is asked for a moment after the last scan, not after each one**, so a run of scans is one page drawn again and not one per scan. What was just counted shows at once in "Last counted".
- **A scan that was not counted stays on the screen until it is cleared** (the last five): in a run of scans, one wrong code is easy to miss.
- **A cancelled count shows only what was counted.** It applied nothing, and what its lines "should" hold would be today's stock, which says nothing about that day.
- **The review draws the first 300 lines of the view picked**, and says how many there are. Counting does not need a line to be on the page.
- The scan box reads the field itself when Enter arrives, not what the page last drew: a scanner types faster than the page.

**Seen and not seen.** Every suite that is safe on dev, one at a time: 41 pass, none fail (`stock-counts` 37, `purchase-orders` 45, `stock-adjust` 31, `stock-engine`, `stock-sales`, `stock-locks`, `pos-operations`, `isolation` among them). The pure checks under node, the type-check and a production build are clean. Every query of the two pages and of the two counting actions was planned against dev. Drawn to HTML from sample rows: the list (with everything, without costs or counting, empty, for someone who may not see stock) and a count (open for someone who counts and sees costs, without costs, for someone who may only see stock, with nothing counted, showing the lines not counted; completed; cancelled; not there; no rights). **The scan box was used in a real browser** on a temporary page with sample lines and stand-in actions (deleted afterwards): three scans of one barcode make 3; a SKU is taken as a code; a code no product has stays under "Not counted" until cleared; a name with one match asks how many and Enter sets it; a name with two matches offers both; letters where a quantity belongs hold the save back; 2.5 is two and a half; five scans drew the page again once. **Nobody has run a count signed in**: starting one, scanning with a real scanner, two people on two devices, completing, printing. The two counting actions themselves were not run; what they call (`count_add`) is what the suite runs.

**To watch, and left for later:**

- A sale that reaches the server after the count was completed is not seen by it (as decided above): complete a count once the tills have synced.
- A whole shop of several thousand lines has not been timed. The review asks, for every counted line, what moved since it was counted; the index on a product's movements by date (`idx_stock_movements_item`) serves that, but the page is drawn again after every run of scans.
- Production needs migrations 0064 to 0076.
