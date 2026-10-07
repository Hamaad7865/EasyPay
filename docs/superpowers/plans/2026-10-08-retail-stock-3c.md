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
