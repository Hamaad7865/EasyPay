# Receipt designer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The receipt (with the bill, refunds and shares) and the kitchen ticket printed from a design of blocks made in the back office, as in `docs/superpowers/specs/2026-10-15-receipt-designer-design.md`.

**Architecture:** A design is a list of blocks kept under `pos_settings.data.papers`. The till's `Docs` walks the blocks (EasyPay's design is today's paper). The back office's preview is the same walk in TypeScript (`web/lib/papers.ts`). Both are held to the shared examples in `db/tests/fixtures/papers/`. No migration.

**Tech Stack:** Kotlin, kotlinx.serialization, JUnit (till); Next.js server actions, React client components, Node's own test runner style (`node web/lib/*.test.mjs` running `.ts` directly).

Built in this session at the owner's word ("Write the spec build it and then tell me when its done and tested also"), inline, no subagents (the owner pays for every one).

---

## Files

Till (`android/app/src/main/java/com/restopos/`):
- `core/print/EscPos.kt`: keeps each line's style (`styled()`).
- `core/print/Papers.kt` (new): `Block`, `Design`, the kinds and their defaults, EasyPay's two designs, the forgiving reader.
- `core/print/PaperWalk.kt` (new): the receipt's and the kitchen ticket's blocks turned into lines (`Out`), and the variables.
- `core/print/Docs.kt`: `DocAddon`; `DocLine.addons`, `DocLine.unit`; `KitchenDoc` serializable; `receipt`, `receiptLook`, `kitchen` take a `Design`; the old `page` and `kitchen` bodies go once the walk is proved the same.
- `core/data/DocBuilder.kt`: fills `addons` and `unit`; hands each paper its design.
- `core/data/PosSettings.kt`: `papers` (the key as text).

Till tests (`android/app/src/test/java/com/restopos/core/print/`):
- `EscPosStyledTest.kt`, `PapersTest.kt` (reader), `PaperWalkTest.kt` (settings, prices, variables), `SameAsBeforeTest.kt` (temporary: old against new), `PapersFixtureTest.kt` (shared examples).

Shared: `db/tests/fixtures/papers/default-receipt.json`, `default-kitchen.json`, and one `*.json` per example.

Back office:
- `web/lib/papers.ts` (new) and `web/lib/papers.test.mjs` (new).
- `web/lib/settings.ts`: `papers` read raw; `savePaper`.
- `web/app/backoffice/receipt-design/page.tsx`: the two saves and the reset.
- `web/app/backoffice/receipt-design/designer.tsx` (new, replaces `receipt-form.tsx`), `preview.tsx` (new).
- `web/app/globals.css`: the designer's and the preview's rules.

## Shared rules (both renderers)

- A block makes a list of `Out`: `Words(text, indent)` (wrapped at the width), `Line(text)` (as it comes; wrapped at half width only when Big), `Row(left, right)` (`EscPos.row`), `Rule(ch)`, `Blank`, `Bars(code)`, `Picture`. Each `Out` carries its style (size, bold, align); `Rule` and `Blank` are normal, not bold, left; `Bars` is centred.
- Width: `columns`, or `columns / 2` when Big. `Row` spans the width and is set left.
- A block that makes nothing prints nothing, not even its line above. The line above is `Rule('-')`.
- A styled line is `{t, size, bold, align}` with `t` trimmed at its end; a barcode adds `{t: "", bars: code, align: center}` before its code's line; trailing blank lines are dropped, as `look()` does.
- Dates in `dd/MM/yyyy HH:mm`, the device's time; the fixtures are read in `Indian/Mauritius`.

### Task 1: EscPos keeps each line's style

- [ ] Test: `EscPosStyledTest`: `EscPos(32).align(Center).bold(true).line("A").big(true).line("B").big(false).tall(true).row("x","1").tall(false).bold(false).align(Left).barcode("S1").styled()` gives A (normal, bold, center), B (big, bold, center), the row (tall, bold, center, "x" padded and "1"), then a bars entry and "S1" centred.
- [ ] Run `.\gradlew.bat --priority low --max-workers 2 testDebugUnitTest --tests "*EscPosStyledTest*"` from `android/`: fails (no `styled`).
- [ ] Add `data class Styled(val t: String, val size: String = "normal", val bold: Boolean = false, val align: String = "left", val bars: String? = null)`; `EscPos` tracks `size` (GS ! sets one register: `big(on)` → big or normal, `tall(on)` → tall or normal), `bolded`, and the alignment; `newline()` adds a `Styled`; `barcode()` adds the bars entry; `styled()` drops trailing blanks.
- [ ] Run: passes; `DocsTest` passes. Commit.

### Task 2: Papers: blocks, defaults, the reader

- [ ] Test `PapersTest`: no key → EasyPay's receipt (32 blocks: logo … barcode) and kitchen (9 blocks); `{"v":2,…}` → EasyPay's; a block of unknown kind skipped; a second `title` skipped; `total` missing → EasyPay's; `items` hidden → EasyPay's; for a shop `barcode` missing → EasyPay's, for a restaurant not; `size: "huge"` → the kind's default; `text` cut at 300; `n: 9` → 1; 61 blocks → the first 60; `ch: "*"` → `-`.
- [ ] Run: fails.
- [ ] Write `Papers.kt`: `Block(k, hide, size, bold, align, above, text, ch, n, addons, addonPrices, unitPrice, notes, was, seat)`; `Design(blocks)`; `RECEIPT_KINDS` and `KITCHEN_KINDS` (kind → its default `Block`), `REPEATABLE = setOf("text", "line", "space")`, `LOCKED_RECEIPT = setOf("title", "items", "total")`, `LOCKED_KITCHEN = setOf("items")`; `RECEIPT`, `KITCHEN` (EasyPay's, the spec's tables in order); `receipt(papers: String?, shop: Boolean): Design`, `kitchen(papers: String?): Design`; `read(...)` returns the design and whether it fell back.
- [ ] Run: passes. Commit.

### Task 3: The walk, proved the same as today's paper

- [ ] Rename today's `page` to `pageBefore` and `kitchen`'s body to `kitchenBefore` (private, temporary).
- [ ] Test `SameAsBeforeTest`: for a dozen papers (receipt at 48 and 32; bill; refund with reason; a share; a reprint partly refunded; a takeaway with a customer number; a shop's with bars; a line with a price change and a note; kitchen for a takeaway, for a table, with courses and seats, a void), `styled()` of the walk with EasyPay's design equals `styled()` of the old code, and the drawer, logo, bars, feed and cut read from the bytes are the same.
- [ ] Run: fails.
- [ ] Write `PaperWalk.kt`: `receiptOut(b: Block, d: ReceiptDoc, shop: Shop, columns: Int, decimals: Int, logo: Raster?): List<Out>` and `kitchenOut(b, d: KitchenDoc, columns): List<Out>` for every kind of the spec's tables; `emit(p: EscPos, outs, above)`. `Docs.page` and `Docs.kitchen` walk the design's shown blocks.
- [ ] Run `SameAsBeforeTest` and `DocsTest`: pass. Commit.
- [ ] Delete `pageBefore`, `kitchenBefore` and `SameAsBeforeTest` once the shared examples (Task 6) hold today's paper. Commit.

### Task 4: Add-on prices, the price of one, notes, the old price; the kitchen's options

- [ ] Test `PaperWalkTest`: the four looks of the spec's section 4 on 48 columns (Burger 250, Cheese 20, Bacon 30); a free add-on with no price; `2 x Egg 30.00`; a receipt kept from before (no `addons`) in a "with prices" design prints as names only with the line's total; price of one `2 x 50.00` and `0.5 x 400.00`, none at quantity 1 or without `unit`; notes hidden; old price hidden; with prices the old price is less the add-ons; kitchen add-ons on one line `* Mayo, Chili, Well done`; seat hidden.
- [ ] Run: fails.
- [ ] `DocAddon(name, qty = 1, price = 0)`; `DocLine.addons = emptyList()`, `DocLine.unit: Long? = null`; the Items kinds read their options; `DocBuilder.lines` fills `addons` from `lineMods` and `unit` from `unit_price`.
- [ ] Run: passes. Commit.

### Task 5: Text, Line, Space and the variables

- [ ] Test: `Thank you {customer}!` with a customer and without (`Thank you !`); `{customer_no}` alone on a line with none → the line not printed, nothing left → no line above; `{nope}` printed as typed; kitchen `{station}` and `{pickup}`; Line `=`; Space 3.
- [ ] Run: fails. Write `vars(...)` for each paper and the three kinds. Run: passes. Commit.

### Task 6: Settings, DocBuilder, shared examples

- [ ] `PosSettings.papers: String?` (the `papers` object as text); a `PosSettingsTest` case reads it and its absence.
- [ ] `DocBuilder` passes `Papers.receipt(s.papers, shop.bars)` to `Docs.receipt` and `Docs.receiptLook`, `Papers.kitchen(s.papers)` to `Docs.kitchen`.
- [ ] Fixtures: `default-receipt.json`, `default-kitchen.json` written from `Papers.RECEIPT`/`KITCHEN` (compact form: a block with only `k` when it is the kind's default). Examples written with `expect` from the walk by `PapersFixtureTest` when run with `-Dpapers.write=true`; the ones of today's paper also checked against `pageBefore`; every new one read by eye.
- [ ] `PapersFixtureTest` (TimeZone `Indian/Mauritius`): EasyPay's designs equal the two files; every example's lines equal `expect`.
- [ ] Run all unit tests. Commit; then Task 3's deletion.

### Task 7: The preview's renderer

- [ ] `web/lib/papers.test.mjs` (as `perms.test.mjs`): reads every example and requires `renderReceipt`/`renderKitchen` to give `expect`; EasyPay's designs equal the two files; the reader's rules as in Task 2.
- [ ] Run `node web/lib/papers.test.mjs`: fails.
- [ ] `web/lib/papers.ts`: the same kinds, defaults, reader (`readDesign(paper, raw, shop)` → `{design, fellBack}`), `compact`, `wrap`, `row`, `num`, `qty`, `stamp` (Intl, `Indian/Mauritius`), the walk, the variables, and the preview's sample orders (`sampleReceipt(kind, takeaway)`, `sampleKitchen(takeaway)`).
- [ ] Run: passes. `npx tsc --noEmit -p web`: clean. Commit.

### Task 8: The designer page

- [ ] `settings.ts`: `PosSettings.papers` (raw object, `{}` when absent); `savePaper(c, tenantId, paper, blocks | null)` merging into `papers` (`null` removes the paper).
- [ ] `page.tsx`: actions `saveReceipt` (design + the notes and logo into `receipt` as before), `saveKitchen`, `resetPaper`; each reads the design with `readDesign`, refuses one that falls back or holds more than 60 blocks ("This design could not be read. Reload the page and try again."), saves it compacted; `settings.device` as today; a shop has no kitchen tab.
- [ ] `designer.tsx`: tabs; the column (drag by the handle with pointer events, Up and Down keys on the open block, the eye, 🔒 on locked blocks, Remove on Text, Line, Space); the open block's settings by its family (words, row, items, kitchen items, text, line, space, logo, header and footer boxes); Add a block (Text, Line, Space); the MRA warning on BRN, VAT number and Taxes when hidden; Back to EasyPay's design; the restaurant's list without Barcode, the shop's without Customer number.
- [ ] `preview.tsx`: styled lines in a fixed-width face, 32 or 48 characters across, Big twice wide and tall, Tall twice tall, bars drawn; the logo on top when its block is shown; switches 80/58, Receipt/Bill, Takeaway/Table.
- [ ] `tsc` clean, `node web/lib/*.test.mjs` pass, the page seen in a browser. Commit.

### Task 9: On an emulator, the owner watching

- [ ] Say before it starts; read the emulator note in memory; check the screen first.
- [ ] Save a design on dev (the back office, or `pos_settings` written by a script when no sign-in is possible, said so); the till pulls it; a receipt and a kitchen ticket printed through the stand-in printer at 80 and 58 mm match the preview; "Back to EasyPay's design" brings today's paper back.
- [ ] Record what was seen and not in this plan's end.
