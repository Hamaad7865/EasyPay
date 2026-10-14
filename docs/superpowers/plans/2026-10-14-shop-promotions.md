# Shop promotions: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop marks slow-moving products down, never below cost, from the back office or from the tablet (online or offline), lifts the markdown to put the price back, and is told which markdowns still do not sell.

**Architecture:** A promotion is a real change to the selling price (the till already follows prices), with the price before it remembered on the line itself (`promo_was` on `items` and `item_variants`, sent to tills with the rows they already pull) and in a `promotions` table (one live row per line; apply, reduce, lift). Three push operations (`promotion.apply`, `promotion.reduce`, `promotion.lift`) are answered by the same server functions the back office calls; a tablet on the offline plan applies them itself and keeps them in its queue, as it does a price change. The two detections are queries, on the server for the back office and on the tablet over its own tables.

**Tech Stack:** as the credit-notes plan (`docs/superpowers/plans/2026-10-14-exchange-policy-and-credit-notes.md`): plpgsql rebuilt from live definitions, Node suites on dev, Kotlin/Room/Compose, Next.js + plain CSS. Same conventions (dev only, never push, suites one at a time, emulator with its window after saying so).

**Spec:** `docs/superpowers/specs/2026-10-14-shop-promotions-design.md`.

**Decisions this plan takes beyond the spec (mine):** a promotion is per line of a product: `(item_id, variant_id)` with `variant_id` null for a product without variants, as stock levels are kept. `promo_was` lives on the line (nullable, the price before the promotion while one is live; null otherwise): the tills need no new pull and the back office's lists read it in one column. The `catalog_import` warning (spec §4) and the "selling again" tag are left for a later pass, said in the record.

---

## Part A: the server (migration 0110)

### Task A1: schema, functions, detections

- [ ] `db/migrations/0110_promotions.sql`: header in the house style; `alter table items add column if not exists promo_was bigint`, the same on `item_variants`; table `promotions` (id uuid pk, tenant_id, item_id, variant_id null, original_price, promo_price, status active|lifted, note, applied_by, applied_at, lifted_by, lifted_at, created_at, updated_at, deleted_at, server_seq; unique (tenant_id, id); FKs by (tenant_id, …); checks `promo_price >= 0`, `promo_price <= original_price`; partial unique index `promotions_one_active on (tenant_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000')) where status = 'active' and deleted_at is null`; RLS, `trg_touch`, the tenant_seq index).
- [ ] `promotion_apply(p_tenant, p_emp, p_item, p_variant, p_price, p_note)`: `items.edit` by `has_perm`; the line `for update`; its cost (`item_variants.cost`, or `items.cost`) must be known and `p_price >= cost` ('below-cost'); `p_price < price` ('not-lower'); no active row ('on-promotion'); insert the row; set `promo_was = price`, `price = p_price` on the line (with `app.price_by` set for a product, as `push_item_set_price` does, so `item_price_changes` says who). Returns the row's id.
- [ ] `promotion_reduce(p_tenant, p_emp, p_item, p_variant, p_price, p_note)`: the active row `for update`; cost floor; `p_price < promo_price` ('not-lower'); `promo_price = p_price`, the line's `price = p_price`, `original_price` untouched.
- [ ] `promotion_lift(p_tenant, p_emp, p_id)`: the row `for update`, active ('not-active'); mark lifted; if the line's price is still `promo_price`, put `original_price` back and return true; else leave it and return false; `promo_was = null` either way.
- [ ] `slow_movers(p_tenant, p_days)`: one row per line (item, variant, name, variant name, category, qty on hand across the shop's stores from `stock_levels`, price, cost, last_sold from `stock_movements` reason 'sale' (as `UNSOLD_SQL` does), idle_since = greatest(created_at, last_sold), days_idle) where qty > 0, no active promotion, idle ≥ days. `stale_promotions(p_tenant, p_days)`: active promotions whose line has qty > 0 and no sale since greatest(applied_at, last sale) ≥ days. `count_slow_movers(p_tenant, p_days)`.
- [ ] `push_promotion_apply/reduce/lift(p_tenant, p_emp, p)`: unpack `item_id`, `variant_id`, `price`, `note`, `id` and call the three; `may(p_emp, p, 'items.edit')`. `sync_push`: the three ops, the codes `below-cost`, `not-lower`, `on-promotion`, `not-active`, `no-cost`. `push_settings_save`: `slowMoverDays` (1..365) and `promoStillDays` (1..365).
- [ ] Apply on dev; suite `db/tests/promotions.test.cjs` (apply: below cost, not lower, no cost, a second active, the price moved and `promo_was` set, `item_price_changes` written; reduce: floor, lower, original kept; lift: restored / left when changed by hand, `promo_was` cleared; slow_movers: never-sold counts from creation, out of stock left out, on-promotion left out, the day it turns; stale_promotions; a cashier refused; the three ops through `sync_push` and the settings). Commit.

## Part B: the tablet

### Task B1: data (database 27)

- [ ] `ItemEntity.promo_was: Long? = null`, `ItemVariantEntity.promo_was: Long? = null`; `PromotionEntity` + `PromotionDao` (`core/database/Promotions.kt`: upsert, `active()`, `activeFor(item, variant)`, `setLifted`, `all()`); `V26_V27` (two `ALTER TABLE … ADD COLUMN promo_was INTEGER`, `CREATE TABLE promotions`); `TillDatabase` version 27, `promotions()`; `AppModule` registers it. PullApplier maps `promo_was` on items and variants and the `promotions` rows. `sync_pull` (0110) sends `promotions` for a shop (active, or changed in 30 days).

### Task B2: rules and the writer

- [ ] `core/data/PromotionRules.kt` (pure, tested in `PromotionRulesTest`): `check(cost: Long?, current: Long, asked: Long): String?` (the sentence, or null), `breakEven(cost, rateBp)`, `reduceCheck(cost, promo, asked)`, `slowMovers(lines: List<Line>, now, days)` and `stale(...)` over plain data (`Line(itemId, variantId, qty, lastSold, createdAt, promo: active?)`).
- [ ] `core/data/Promotions.kt` (@Singleton): `apply(itemId, variantId, price, note, approver)`, `reduce`, `lift(promotionId, approver)`: `staff.allow("items.edit")`, the rules, one transaction (the line's price and `promo_was`, the row, `till_log` "price" as `Service.setPrice` writes it, the op enqueued), `pushNow`; `slowMovers()` and `stale()` from the tablet's tables (stock levels of this store, last sale from `receipt_lines` joined through `ticket_lines` on this tablet, as `OpsDao.receiptsBetween` reads receipts). `LocalAnswers.KINDS` + `change()`: the three ops are no-ops there (the change is already on the tablet).

### Task B3: the screen

- [ ] `feature/retail/Promotions.kt`: `PromotionsViewModel` (the two thresholds from settings, the three lists, a sheet state) and `PromotionsScreen` (the thresholds as two sentences with the numbers; Slow movers; On promotion; Still not selling; Set promotion sheet: one row per line with cost, now, in stock, a price box and the three sentences; Reduce again; Lift). A key **Promotions** on `ProductsScreen`'s head beside Categories (shop only); `Screen.Promotions` in `MainShell` if screens are an enum there, else the sheet opens over Products. The Sell tile and the Products list show the old price struck through when `promo_was != null`. Help: "Promotions".
- [ ] Build, unit tests, commit.

## Part C: the back office

- [ ] `lib/settings.ts`: `slowMoverDays` (30), `promoStillDays` (14); the General card for a shop: a "Promotions" card with the two numbers (or on the page itself, as Kids Corner has them: the page, with `settings.device` to change).
- [ ] `app/backoffice/promotions/page.tsx` (Catalog group, `only: "retail"`, icon `TicketPercent`): the two thresholds (forms), Slow movers (Set promotion as a `<details>` per product with a row per line: cost, now, in stock, price box; the sentences in `<small>`; a server action `applyPromotion` calling `promotion_apply` per line typed lower), On promotion (Was struck through, Now, Off, Applied by/when, Lift), Still not selling (Reduce again with a price box, Lift). `counts/route.ts`: slow movers beside Promotions. The product page: Was beside Now on a promoted line and a Lift key; the products list: Was struck through in the price cell.
- [ ] `shop-pages` section Z: the page opens empty; a product made a slow mover (its `created_at` set back 40 days), applied, listed with Was/Now, lifted. Type-check. Commit.

## Part D: run it, record it

- [ ] On the test emulator (say first, with its window): the made-up shop; Promotions under Products & stock; a slow mover (the seed's products have no sales: all idle since creation, so the list is full), Set promotion on one, the Sell tile's struck-through price, Lift. Record in the spec's last section; memory.
