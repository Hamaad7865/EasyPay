# EasyPay in Claude: a connector for the owner's own Claude

2026-10-29. Asked by the owner after Kids Corner's import went badly: "we will create a connector or mcp,
the owner will connect his claude app to the software. Then for example he will say, import 6 shirt with
category shirt, opening stock 6 … we should be able to do everything, create a new category, delete
everything". Then: "the ai needs to show how it will appear in the android apk for example if I say Please
open stock for Shirt Long Sleeve quantity 5 variant color red, size 3 - 6m, style striped". And: "we need to enable every action edit add update delete but claude gives warning
when something bad will happen … we should be able to delete everything and restart as from zero … theres
one item but over 200 variants. Claude app should be able to also manipulate them and splitting those into
different products and then the owner will approve them". Every choice below was settled with the owner in
grill-me rounds (Q1 to Q35, all taken as recommended). "lets use it this way" settled that the owner's
Claude subscription is used in Claude itself, through the connector.

## Why

- Kids Corner on production, read on 2026-10-28:
  - One live product, "Chemise  Long Sleeve" (two spaces), holds 284 lines. A deleted twin, "Chemise
    Long Sleeve", still has one line that was never deleted.
  - Colour has 84 spellings for about 58 colours: white 28 / White 3, Palr Blue, Military c, Bois de
    roses / Bois des roses / bois de rose, and the same mix written White / pale blue, white/ pale blue,
    white/paleblue.
  - Style has 12 spellings for 6 styles: stripe 56, Stripes 22, Stripe 2, Striped 1, stripes 1, and so on.
  - No line has a cost. 137 lines have no SKU. Navy Blue / 15 / stripe is at -2.
- The tablet shows every spelling as its own key, so reports split one colour into several, and the
  Print labels search finds one spelling only.
- The owner wants to say what they want in plain words, from their phone in the shop, and see how it will
  look on the tablet before anything changes.
- The owner's Claude subscription can only be used in Anthropic's own apps. Other apps may not offer
  "Sign in with Claude" or run requests on someone's subscription. So EasyPay goes into Claude as a
  connector, rather than Claude coming into EasyPay.

## What was decided

| # | Decision |
|---|---|
| Where | The owner adds EasyPay to their own Claude app as a custom connector, first. A chat inside the back office comes later (piece 3), on the same tools, paid by EasyPay. |
| Q1 | Premium and trial only, no extra charge. The offline plan has no server, so it has no connector. |
| Q2 | Claude → Settings → Connectors → Add custom connector → EasyPay's address → the back office sign-in → an Allow page → done. The connector lives inside the back office. A **Connected apps** page lists each connection with Disconnect. |
| Who | Back office logins whose role has a new permission, **Use the assistant**. It is off in every role but the owner's (which holds `*`). Each person acts with their own permissions. |
| Q3 | Every change shows a preview card drawn like the tablet. It has four parts: "I read this as", the product's tile, the tablet's variant sheet with the line lit, and stock before → after. The card is built from the real result of the change, run and rolled back. |
| Confirm | Every change waits for Confirm. Questions need no confirm. |
| Q4 | Confirm is a button on the card, and the AI must not be able to press it. That is checked on the test copy; if the check fails, every confirm opens the back office page. A back office page with the same preview is the fallback. A preview lasts 15 minutes, or until what it touches changes. |
| Q5 | A word that matches values already used, ignoring capitals, spaces and plurals, takes the spelling most lines use. A word matching nothing is marked **New** in yellow. |
| Q6 | A product or category not named exactly is searched for, and the owner chooses. Nothing is created unless the owner says "new". |
| Q7 | A new line with no price said: if every line of the product has one price, that price is used. Otherwise the assistant asks first, suggesting the nearest lines' price (same age). Cost stays empty unless given. |
| Q8 | "Open stock" is only for a new line. On a line that exists, the assistant asks "add N or the count is N?", plus a reason: received, found, damaged or lost. A count is a stock count. |
| Q9 | Stock goes to the person's working branch, named in the card, unless the owner names another. |
| Q10 | A delete hides the item, as the back office's Delete does, and history keeps it. The warning card is red: lines, pieces, stock value and pictures; the button names it. A category with products in it can't be deleted unless they are moved or deleted in the same change. The assistant can never delete sales, receipts, payments, customer accounts, back office logins or the shop. |
| Q11 | The assistant answers in the owner's language. The shop's values stay as written. The card's own words are English, like the back office. |
| Q12 | Every confirmed change is logged: who, when, what was asked, before → after. A back office page shows the log. |
| Q13 | A delete can be restored from the log for 30 days. Other changes are undone by asking for the change back. |
| Q14 | One Confirm per change, however big; the full list folds under a summary. Typing the shop's name is also needed to delete a whole product or category, or for any change over 50 lines. |
| Q15 | "Tidy the colours of X": one change per option. Groups like "white (28), White (3) → White", each group in title case, and any group can be changed before Confirm. |
| Q16 | Two lines that become one in a tidy are merged and their stock is added together. The kept line keeps its barcode; the card warns that the other line's labels stop scanning. |
| Q17 | A new line follows the shop's automatic-barcode setting, and the barcode shows in the card. |
| Q18 | Not in the first version: pictures (still set in the back office) and printing labels (still from the tablet). |
| Q19 | Questions: stock, sales, best and slow sellers. Cost and profit need **See cost and profit**. Sales need **See reports**. Customers: names and what they owe (with See reports), never phone or email. |
| Q20 | Settings (piece 2): taxes, discounts, promotions, till staff and roles, receipt wording. Never: PINs, passwords, back office logins, printers, tills, the plan, the MRA connection, payments. |
| Q21 | Tested on a test copy of the back office at a public test address, against the dev database. The owner connects it from Claude, because Claude can't reach this PC. Production only after that. |
| Q22 | Kids Corner's clean-up is the assistant's first real job on production (see Q35). Nothing is changed before it. |
| Q23 | The back office chat's component, model and price are decided at the start of piece 3. |
| Q24 | Order: piece 1 (below, released as 1a then 1b, Q34), then 2 (settings), then 3 (the back office chat). Each is released once tested. |
| Q25 | For now the back office has a **Use EasyPay in Claude** page (the address and the steps), and no chat. Piece 3 adds a chat on EasyPay's own AI account, with a cheap model and a monthly allowance per shop. An owner's own API key may sit beside it later. |
| Q26 | The Allow page says, in one line, that Claude will read and change the shop's data as this person, and that what it reads goes to Anthropic under their own Claude account. |
| Q27 | A connection stays until Disconnect, or until the login loses the permission, is removed, or the shop is suspended. While suspended it can still answer questions but changes nothing. |
| Q28 | Questions are answered with cards too, which change nothing: a product's stock as a grid (one per style, colours down, ages across, red below zero, amber low); lists of lines; a line's history (opening, sales, found, damaged, transfers, who and when, newest first). Tapping a number in a grid opens that line's history. |
| Q29 | Edit one line: its values, price, cost, barcode or SKU. Edit a product: name, category, brand, price, option names. An edit that gives a line another line's values offers a merge (Q16). |
| Q30 | Warnings, said by Claude and shown on the card. Amber: a price below cost, stock going below zero, a barcode change when labels are printed, a New spelling, editing a line that has sold. Red: any delete, and Start over. Typing the shop's name: the Q14 cases and Start over. |
| Q31 | **Start over**, only while the shop is being set up (`platform.setting_up`). One change hides every product, line and category, with their stock and pictures; red card, typed shop name. Tills, staff, settings, customers and suppliers stay. Test sales stay until EasyPay clears them in /admin. Restore for 30 days. Not offered after Go live. |
| Q32 | **Split** a product by an option, or by groups of values. Each line moves with its barcode, stock and history. The option split on leaves the new products and goes into their names. Each new product can be renamed and given a category before Confirm, and the old product is deleted once empty. A tidy is offered first when the option has several spellings. |
| Q33 | **Move** lines, or **merge** a whole product, into another product, keeping barcodes, stock and history. Values that don't fit the other product's options are mapped with the owner before the card. |
| Q34 | Piece 1 is released in two steps. 1a: connecting, the cards, add, edit, delete, Start over. 1b: tidy, split, move and merge, "tidy the stock" and file import. Sub categories come before both (Q45). |
| Q35 | Kids Corner tidies and splits what it has rather than starting over. That keeps the barcodes on its labels and the 582 pieces counted. Its first job: "tidy the stock" (Q46). |
| Q36 | **Sub categories**, one level deep (Shirt › Long Sleeve). |
| Q37 | A product has one category: a sub category, or a category with no subs. |
| Q38 | Tablet: tapping a category in the Sell screen's list opens its subs under it, indented, with "All Shirt" first. Search and scanning as today. A new tablet version. |
| Q39 | Back office: Categories page has Add sub category, and a sub can be moved to another parent. The product page picks "Shirt › Long Sleeve". The import gets a **Sub category** column; a file without it imports as today. |
| Q40 | A sub category takes its parent's settings (Count its stock, colour, MRA nature, kitchen printers) unless set on itself. |
| Q41 | Reports by category add subs into the parent, and each parent opens to show them. |
| Q42 | A category with subs or products can't be deleted unless they are moved or deleted in the same change. |
| Q43 | Claude makes, renames, moves and deletes subs, and moves products into them. A split can put its products in a sub. Cards show the path. |
| Q44 | Shops and restaurants both. |
| Q45 | Sub categories are their own release, first, before 1a. |
| Q46 | **"Tidy the stock"**: Claude reads the catalog (or part of it) and proposes one plan, a tree of categories › subs › products › variants. The owner corrects it in words, and each correction redraws the card. |
| Q47 | One Confirm, all or nothing, in one transaction. Logged as one change, with Restore for 30 days. |
| Q48 | Claude sends the plan as rules, not line ids. EasyPay expands them, and refuses unless every line lands somewhere, the pieces are equal before and after, and every barcode is kept except where the card says. The check shows in green. |
| Q49 | Claude suggests product names (sub + value), and the owner can change any of them. Names are written as shown. |
| Q50 | Kids Corner's option Age becomes **Size** in its plan. |
| Q51 | "Tidy the stock" is in release 1b. Order: sub categories, 1a, 1b, then Kids Corner's tidy. |
| Q52 | **Import a file through Claude**: the owner drops an xlsx in Claude. Claude reads any layout, maps the columns, and sends the rows to EasyPay in parts. Nothing goes in before Confirm. |
| Q53 | The import card: products new and updated, new lines, opening stock per branch; how Claude read the file; the spelling rules applied; each problem with Claude's proposed fix. Confirm imports the ready products, and the rest are listed, never half imported. |
| Q54 | More than three options: Claude asks whether to fold the extra one into a value, into the name, or into its own product. |
| Q55 | Rows for lines that already hold stock: Claude asks once whether to add (received) or replace (count). They become stock changes inside the same Confirm. |

## Release 0: sub categories (Q36 to Q45)

Released first, on its own, for shops and restaurants alike.

- **Database** (one migration):
  - `categories.parent_id`: null for a top category, else the category it sits under.
  - A guard refuses three things: a parent that is itself a sub, a parent from another business, and a
    category that has subs being put under another (one level only).
  - A sub's own `color`, `is_stock`, `mra_nature` and `printer_ids` may be empty, meaning "as the
    parent" (Q40). One function, `category_settings(tenant, category)`, answers what applies, and
    everything that reads those settings asks it: the till's pull, kitchen printing, the MRA invoice
    and Count its stock.
  - Deleting a category that has live subs or products is refused (`category-not-empty`, Q42), unless
    the same change moves or deletes them.
  - The till pull sends `parent_id` with the categories, through the usual `select *`.
- **Import:**
  - A new **Sub category** column, next to Category.
  - `catalog_import` finds the sub under that category by name (capitals aside), or makes it.
  - A sub category with no category is a problem (`sub-without-category`).
  - A file without the column imports exactly as before.
- **Back office:**
  - **Categories page:** subs are listed under their parent, indented, with **Add sub category** on
    each top category, and a parent picker on a sub to move it. A sub's settings show "as Shirt" until
    set.
  - **Product page and the product list:** the category picker shows "Shirt › Long Sleeve". The list
    can be filtered by a parent (which includes its subs) or by a sub.
  - **Reports by category:** subs add up into the parent row, and the row opens to show them (Q41).
- **Tablet (new version):**
  - Room migration adding `parent_id`.
  - The shop's Sell screen category list and the restaurant's menu categories show top categories.
    Tapping one with subs opens them under it, indented, with "All Shirt" first, and the tiles follow
    what is picked (Q38).
  - Categories with no subs work as today. Search and scanning are unchanged.
- **Tests:**
  - A database suite for the guard, inheritance, delete refusal, the import column, and the pull
    carrying `parent_id`.
  - Page tests for the Categories page and the picker.
  - Unit tests on the tablet's list (which tiles show for a parent, a sub, All).
  - A look on the emulator.

## Piece 1

### How the owner connects

- **The address.** `https://easypaypos.com/mcp`. The public site's Worker hands these paths to the back
  office (`site/_worker.js` `BACK_OFFICE`, `site/_routes.json`):
  - `/mcp`
  - `/oauth/*`
  - `/.well-known/oauth-protected-resource*`
  - `/.well-known/oauth-authorization-server`
  It must stay reachable from Anthropic's addresses (160.79.104.0/21), which Cloudflare already allows.
- **The back office is the sign-in server** (OAuth 2.1, as Claude's connector docs require):
  - `/mcp` without a valid token answers **401** with `WWW-Authenticate: Bearer resource_metadata="…"`.
  - Protected-resource metadata (RFC 9728): `resource` is exactly the address above, and
    `authorization_servers` has one entry.
  - Server metadata (RFC 8414): S256 PKCE only, and the token endpoint takes form-encoded bodies.
  - Dynamic client registration at `/oauth/register`, which is what Claude uses by default. Only the
    callback `https://claude.ai/api/mcp/auth_callback` is accepted.
  - `/oauth/authorize` is a back office page:
    - Someone not signed in goes to `/login` and comes back.
    - The page checks that the login's employee is active and holds Use the assistant, and that the
      shop is Premium or trial.
    - It then shows the Allow page: the shop's name, who is signed in, the Q26 sentence, and Allow /
      Cancel.
  - `/oauth/token` swaps the code for an access token (1 hour) and a refresh token. Each refresh
    rotates it (the old one stops working). A connection has no end date of its own (Q27).
- **Tables** (one migration):
  - `assistant_clients`: the registrations. Not a tenant table; read only by the token endpoints.
  - `assistant_grants`: tenant, employee, login, client, and the token and refresh hashes (SHA-256,
    never the tokens). Also connected on, last used, and disconnected on. RLS per tenant.
  - `assistant_codes`: short-lived authorization codes with their PKCE challenge, used once.
- **Every call to `/mcp`**:
  1. The token gives the grant.
  2. Refused if the grant is disconnected, or the employee is inactive or deleted, or lacks Use the
     assistant, or the plan is not Premium or trial. A refusal disconnects the grant (Q27).
  3. A suspended shop gets the question tools only.
  4. Everything after runs as `app_user` with `app.tenant_id` set (`withTenant` / `readTenant` in
     `web/lib/db.ts`), and each tool checks the person's own permission with `has_perm`.
- **The permission.** `assistant.use`, "Use the assistant (Claude)", in the Back office group of
  `web/lib/perms.ts`, for restaurants and shops alike. The tools themselves are shop tools in piece 1
  (below). A restaurant's login can connect, but gets only the tools that mean something for a
  restaurant, which in piece 1 are the questions.

### The server

- One Next.js route, `web/app/mcp/route.ts`. It uses `@modelcontextprotocol/server` (2.x,
  `createMcpHandler`, which has a Workers build) and is stateless: each request stands alone.
- Requests whose Host or Origin is not ours are refused (the SDK doesn't check this).
- At most 120 tool calls a minute per connection.
- The tools live in `web/lib/assistant/`, one file per area. They are plain functions taking
  `(client, ctx, input)`, so piece 3's chat calls the same code. They never write raw SQL: each change
  runs the database function the back office form for it already runs. The plan names each one (for
  example `variant_add` 0142, `variant_value_rename` 0141, `catalog_import`).
- Quantities are said in pieces and kept in thousandths (5 pieces = 5000). Prices are said in rupees
  and kept in cents. This conversion is the tool's job, never the AI's.
- **Risk to test first:** this SDK has not been run inside the OpenNext Worker. The first step of the
  plan is a "hello" tool on the test copy, connected from Claude by the owner.

### Tools

Questions (the AI may call them freely; nothing changes):
- `find`: products, categories and lines by words. It matches names, category, brand and values,
  ignoring capitals, spaces and plurals, and returns candidates with their ids.
- `product`: one product, with its options; each value with how many lines use it; its lines with
  price, barcode and stock per branch; cost only with See cost and profit.
- `stock`: stock by product, option value or branch; lines below zero; lines running low.
- `sales`: by day or period, by product or value; best and slow sellers. Needs See reports.
- `owing`: customers and what they owe. Needs See reports. Never phone or email.
- `history`: one line's stock movements, newest first, 50 at a time: reason, quantity, branch, who,
  when, and the receipt or delivery it came from. Needs `stock.view`.

These answer with read-only cards (Q28), drawn by the same renderer as the previews:
- a product's grid, one per value of its last option when it has three, else one: the first option
  down, the second across;
- a list of lines;
- a line's history.
Pressing a number in a grid calls `history` from the card. That needs the tool to be visible to the
card as well as the AI, which is harmless because it only reads.

Changes (each returns a **preview card** and changes nothing):
- `add_line`: one new line with its opening stock (the owner's example).
- `change_stock`: add N or count N, with a reason, at a branch.
- `edit_lines`: price, cost, SKU or barcode of one or many lines, and one line's values (Q29). Values
  that equal another line's offer a merge instead.
- `edit_product`, `edit_category` (with the verb in the input: new, rename or move): products and
  categories. A new product can come with its options, or with none plus an opening stock (the owner's
  first example: "import 6 shirt with category shirt, opening stock 6").
- `tidy`: one option of one product (Q15, Q16).
- `delete`: lines, a product, or a category (Q10, Q14).
- `restore`: a delete, or a Start over, from the log (Q13).
- `start_over`: while setting up only (Q31). Release 1a.
- `split`: one product into several, by an option or by groups of values (Q32). Release 1b.
- `move`: lines, or a whole product, into another product (Q33). Release 1b.

- `plan`: "tidy the stock", rules for a whole catalog or part of it (Q46 to Q50). Release 1b.
- `import`: rows read from an uploaded file (Q52 to Q55). Release 1b.

`tidy`, `split`, `move`, `plan` and `import` come in release 1b. Everything else is in 1a. Every tool
knows sub categories (Q43): `edit_category` makes, renames, moves and deletes them, and paths show as
"Shirt › Long Sleeve".

The Confirm tool, `confirm(proposal, code)`, has `_meta.ui.visibility: ["app"]`: Claude hides it from
the AI and only the card's button calls it. Claude doesn't promise to refuse a call the AI makes anyway,
so the server refuses any confirm without the card's one-time code. Each change tool also takes
`asked`: the owner's words, kept for the log.

**Where the code travels, and what is promised:**
- The code goes only in the tool result's `_meta`, never in its text or `structuredContent`. The MCP
  Apps spec describes `_meta` as "not intended for model context", but as advice, not a rule. Claude's
  own handling is not documented.
- **Guaranteed human:** a confirm on the back office page, which needs the person's own signed-in
  browser.
- **The card's button:** protected as long as Claude keeps `_meta` from the AI. That is checked on the
  test copy (below) by asking Claude to read out the code and to confirm by itself. If either works,
  the card's button goes, and every confirm opens the back office page.

### The preview is the real change, undone

1. The change tool opens a transaction as the tenant, runs the real function with the parameters it
   resolved, and reads back the rows a card needs: the product, its lines, their stock at the branch,
   the category, what a delete would hide.
2. It then rolls back. Nothing is kept.
   - Every value the database filled in during that run is read back and becomes a parameter. This
     covers the automatic barcode (`assign_barcodes` takes it from `barcode_counters`, which the
     rollback winds back, and another line made meanwhile would take it), the suggested price and the
     branch.
   - Confirm passes them explicitly, so the barcode on the card is the barcode made. If it was taken
     in between, the proposal is stale.
3. It writes a proposal (`assistant_proposals`, RLS per tenant). The proposal holds:
   - the kind and the resolved parameters;
   - before and after, and the "I read this as" list;
   - the touched rows' `updated_at`;
   - a random one-time code, stored hashed;
   - the grant, the employee, and an expiry 15 minutes ahead.
4. Confirm checks, in order: the code, the expiry, that the proposal is unused, the person's
   permissions again, and that no touched row's `updated_at` has moved. It then runs the same function
   with the **stored** parameters, never anything sent with the confirm, and writes the log.
5. An expired or stale proposal answers "Show it again" and changes nothing.

Because the card and Confirm both come from the stored proposal, a product name or note that carries
instructions can't steer the change, and the card can't differ from what Confirm does.

### Resolution rules ("I read this as")

- **Product.** An exact name (capitals and repeated spaces aside) is used. Otherwise the AI gets the
  candidates and asks (Q6). "Shirt Long Sleeve" is not exact: it finds Chemise Long Sleeve, which
  matches "Long Sleeve" and is in the Shirt category, and the AI asks before going on.
- **Option.** The AI maps the owner's word to the product's option ("size" → Age). The card shows the
  mapping, so a wrong one is seen before Confirm.
- **Value.**
  - The owner's word is compared without capitals, spaces or punctuation, with plurals and "-ed" folded
    ("striped" ~ stripe ~ Stripes).
  - Matches take the spelling most lines use, with the counts shown.
  - "3 - 6m" is the same as "3-6m".
  - No match is **New** (yellow).
- **Stock reason** (Q8): the plan maps received, found, damaged and lost to the movement reasons the
  stock pages already record, and a count to a stock count.
- **Branch** (Q9): a call from Claude has no working branch picked in a browser. A shop with one branch
  uses it. A shop with several is asked which, unless the owner named one, and the card names it.
- **Price** (Q7) and **barcode** (Q17) as decided. The card says where each came from:
  "said", "the product's price", "suggested from Red / 3 / Plain", "made by the shop's barcode setting".

### The card

- An MCP App: one HTML resource (`ui://easypay/preview`) with the card's data in the tool result.
- The same renderer, a plain TypeScript function that turns a proposal into HTML, also draws the
  back office fallback page `/backoffice/assistant/p/<id>`. That page shows only to the person who
  made the proposal, and Confirm works there too.
- The tool's text answer always carries that link, for a Claude app that can't draw the card or can't
  press its button (not confirmed on phones).
- **Drawn like the tablet:** the till's colour tokens (`core/ui/V2.kt`: Bg, Panel, Key, On, OnText, the
  green Add key, AmberText, RedText), light or dark following Claude, and the shapes of
  `RetailSell.kt`:
  - the product tile: picture, name, price;
  - the variant sheet (`VariantSheet`): a 72 px picture and the name and price on top; per option a
    label, then rounded keys (14 px corners); on the last option's keys, "N left" in the stock tone;
    the lit line in On colours.
- **The four parts** (Q3):
  1. "I read this as", each row with **New** where it applies.
  2. The tile.
  3. The sheet with the new or changed line lit.
  4. Stock before → after at the named branch.
  A product with no options never opens a sheet on the tablet, so its card has parts 1, 2 and 4.
- **Bigger changes:** a summary ("tidy Colour: 84 spellings → 58, 103 lines renamed, 1 pair merged")
  with the lists folded underneath.
- **A delete:** red, listing lines, pieces and their value at cost (when the person may see cost),
  pictures, and tablets losing it at their next sync. The button names it ("Delete 284 lines, 582
  pieces"). Typing the shop's name is needed past the Q14 threshold.
- **Buttons:** Confirm (green, like the tablet's Add) and Cancel. After Confirm the card shows "Done",
  and the sheet as it now is.

### Tidy and merge

- `tidy` groups an option's values by the comparison above.
- Each group's spelling is title case ("Pale Blue", "Stripe"), and the owner can rename any group
  ("call it Off White") before confirming.
- Confirm runs `variant_value_rename` for each group.
- Lines that would become one (Kids Corner: White / pale blue / 13 / Stripe and white/paleblue / 13 /
  stripe) are first merged by a new function, `variant_merge(keep, drop)`:
  - the dropped line's stock at each branch moves to the kept one, recorded as a matching pair of
    movements;
  - the dropped line is deleted, and its barcode stops scanning (the card warns).
  - The kept line is the one with more stock, or with more sales if stock is equal.
- The deleted twin's leftover line is shown in Kids Corner's tidy as something to delete.

### Deletes and Restore

- A delete sets `deleted_at` on what it covers, through the functions the back office's Delete uses.
  History keeps it, and tablets drop it at their next pull.
- A category that still has products is refused unless the same change moves or deletes them.
- Restore, from the log for 30 days, is a new function. It clears `deleted_at` on exactly the rows
  that change hid. It refuses if a line with the same values, or the same barcode, was made since.
- Never reachable: sales, receipts, payments, customer accounts, back office logins, the shop.

### Warnings (Q30)

- Each proposal carries a list of warnings, worked out by the server from the rows read back, never by
  the AI. The AI repeats them in words, and the card shows them above the buttons.
- **Amber:**
  - a price below the line's cost;
  - stock going below zero;
  - a barcode changed, or dropped in a merge, on a line that has printed labels (the shop's label
    history, else any line with a barcode);
  - a New spelling;
  - an edit to a line that has sold.
- **Red:** every delete, and Start over.
- **Typing the shop's name:** the Q14 cases and Start over.

### Start over (Q31)

- A new function, `catalog_start_over(tenant)`, refused unless the shop has its `platform.setting_up`
  row. In one change it hides:
  - every product, line and category;
  - their stock rows;
  - the pictures' links.
  It changes no stock movement, sale, till, staff member, setting, customer or supplier.
- The red card counts what goes: products, lines, categories, pieces and their value, and pictures.
  It says test sales stay until EasyPay clears them, and that Restore brings everything back for 30
  days.
- The plan checks that an import after Start over makes new products rather than finding the hidden
  ones by name, so the new catalog starts clean.

### Split, move and merge (Q32, Q33)

- A new function, `variants_move(tenant, lines, to_item, drop_option)`, moves lines to another product
  and keeps their ids, so each line's barcode, stock levels and movements go with it:
  - `item_variants.item_id`, `stock_levels.item_id` and `stock_movements.item_id` follow;
  - when `drop_option` is given, that value leaves `option_values` and the name;
  - a line that would equal one already in the target is refused, with the clash named (or offered
    as a merge, Q16).
- **`split`** makes the new products first, in the same transaction:
  - the old product's category, brand, sold-by and stock setting are copied;
  - its option names lose the split option;
  - the product price is the price most of its lines have;
  - the name is the old name plus the value or group ("Chemise Long Sleeve Stripe"), and the owner can
    change it on the way.
  - Then the lines are moved, and the old product is deleted when nothing is left in it.
- **`move`** puts lines, or every line of a product, into an existing product. Values are mapped to the
  target's options with the owner first ("Style is not an option there: drop it, or add it?").
- **Sales:** receipts keep the name they printed (`receipt_lines.name_snapshot`), and a line's own
  history goes with it. The plan checks how reports by product group a moved line's past sales, and
  says so in the card if they stay under the old product.
- **Tablets:** they get the moved lines with their next pull. The plan checks that the tablet's pull
  applies a line's new product (and its stock rows), on the emulator, before release 1b.

### Tidy the stock: one plan (Q46 to Q50)

- **`plan` tool.** Claude first reads the catalog or a part of it through the question tools (values
  with counts, names, categories). It then sends a plan made of rules:
  - categories and subs to make or keep;
  - for each product: its category path, its value renames per option, its option renames (Age →
    Size), and whether to split it by an option (with a name per value or group) or move it into
    another product;
  - deletes (an emptied product, a twin's leftover line).
- **The server expands the rules** into exact steps on exact lines, using the same functions as the
  single tools: `variant_value_rename`, `variant_merge`, `variants_move`, category saves and deletes.
- **It refuses the plan unless:**
  - every live line ends in exactly one product;
  - the pieces per branch are equal before and after;
  - every barcode is kept, except the ones the card names as lost in a merge;
  - no product passes 1000 lines.
- **The card is a tree** (category › sub › product), each product with its lines and pieces. It opens
  to show its options and values, each value with the spellings it came from. "New", "kept" and
  "deleted" are marked, and the check shows in green.
- **Corrections** ("call it Long Sleeve Design", "put 3-6m to 24m in a Baby sub") make a new proposal
  and a new card. The last one is the one that can be confirmed.
- **Confirm** runs every step in one transaction, logged as one change. Restore undoes it for 30 days:
  it puts each line back in its old product with its old values, and brings back what was deleted. It
  refuses if any of those lines changed since.
- Names are suggested as sub category + value ("Long Sleeve Design") and written as shown on the card.

### Importing a file through Claude (Q52 to Q55)

- Claude reads the uploaded xlsx itself and maps its columns to the import's own columns: name,
  category, sub category, price, cost, options and values, barcode, SKU, stock, sold by, count stock.
- **`import` tool.** It takes the mapped rows in parts of up to 200, for a draft kept on the server
  (`assistant_imports`, RLS per tenant, gone after a day).
  - With the last part it runs `catalog_import` as a dry run, with the spelling rules of Q5 applied to
    the values first. The card is built from that answer.
  - The card shows: products new and updated, new lines, opening stock per branch; how Claude read the
    file ("Couleur → Colour"); the rules applied ("striped → stripe"); and each problem with its row
    number, its reason (the import's own) and Claude's proposed fix.
- **A fourth option** (Q54): Claude asks how to fold it in before it sends the rows: into a value
  ("Beige (lin)"), into the name, or as its own product.
- **Lines that already hold stock** (Q55): `catalog_import` skips the stock of a line that holds some
  or has moved. Claude asks once whether to add (received) or replace (count). Those rows become stock
  changes of the same proposal.
- **Confirm** runs the import for real with the stored rows and those stock changes, in one
  transaction. Products with a problem are left out and listed, as the back office import does.
- The tablet sees the result at its next pull. Not confirmed yet: that Claude reads xlsx on the
  owner's plan and on the phone. This is checked on the test copy.

### Kids Corner's first job (Q35, Q50)

"Tidy the stock":
1. Make Shirt › Long Sleeve.
2. Tidy Colour (84 spellings → about 58) and Style (12 → 6), merging the one pair that clashes.
3. Rename Age to Size.
4. Split by Style into five products under Shirt › Long Sleeve: Long Sleeve Plain 150 lines, Stripe 82,
   Design 29, Plain Colle Mao 15, Stripe Colle Mao 8.
5. Delete the emptied Chemise Long Sleeve and its twin's leftover line.

The owner runs it from their Claude after release 1b.

### Back office pages

- `/backoffice/assistant`, under Settings, for whoever holds Use the assistant:
  - **Use EasyPay in Claude:** the address, with a Copy button, and the steps (Settings → Connectors →
    Add custom connector; add it on the web or desktop and it then shows on the phone). It notes that
    Claude's free plan allows one connector.
  - **Connected apps:** who, connected on, last used, Disconnect. The owner sees everyone's; others see
    their own.
  - **Changes:** when, who, what was asked, before → after, and Restore on a delete for 30 days.
- `/oauth/authorize` (the Allow page) and `/backoffice/assistant/p/<id>` (the fallback confirm).
- Pages a shop also has say shop, catalog and products, never kitchen or menu, as every shared page
  does.

## Not in piece 1

- Pictures and labels (Q18). Settings (piece 2). The back office chat (piece 3).
- No change on the tablet: changes reach it by the usual pull, and the card only draws its look.
- The offline plan.

## Testing

- **Database suites on dev**, in one transaction that rolls back, as the others do:
  - a proposal changes nothing;
  - Confirm makes exactly what the card showed: the rows read at the preview equal the rows after
    Confirm, ids aside but barcodes included, even with a line made by someone else in between;
  - stale, expired and used proposals are refused, and so is a wrong code;
  - permissions: no Use the assistant, no `stock.adjust`, no See cost and profit;
  - a suspended shop and an offline plan;
  - a delete then Restore, and Restore refused after a clash;
  - `variant_merge` with stock at two branches;
  - the tidy of a copy of Kids Corner's values (84 → 58, 12 → 6, one merge);
  - Start over: refused once live, and its Restore;
  - a split of a copy of Kids Corner's 284 lines by Style (150 / 82 / 29 / 15 / 8): every barcode and
    every stock level still there, history attached, the old product deleted;
  - a move refused on a clash;
  - the warnings: each one raised by the case that should raise it, and not otherwise.
- **Sign-in.** The endpoints are tested against dev with a script that plays Claude's part: register,
  PKCE, code, token, refresh and its rotation, a 401 with the header, and a disconnected grant
  refused. No hosted-auth account is made: the authorize step is given a signed-in context as the
  existing page tests do.
- **Tools.** Through the SDK's in-memory client: each tool's input and output, and the owner's own
  sentence "open stock for Shirt Long Sleeve quantity 5, colour red, size 3 - 6m, style striped"
  against a copy of Kids Corner's lines. Expected: Chemise Long Sleeve, Age, 3-6m, stripe, a price
  question, then a card. Also "import 6 shirt with category shirt, opening stock 6". Expected: a
  question first (a new product called Shirt, or one of the shirts there?), then a card with the tile
  and 0 → 6.
- **The card.** Rendered in headless Chrome from fixtures, light and dark, at phone width and desktop
  width. Its keys are checked against the tablet's sheet.
- **The test copy (Q21).** A second Worker of the back office at a public test address, pointed at
  dev-review. The owner's part:
  - add that address to the sign-in service's trusted domains;
  - add the connector in Claude, sign in with a test shop, and try the example from the phone;
  - ask Claude to read out the Confirm code and to confirm by itself. Both must fail, or the card's
    button goes (see Tools).
  Only then production, with the usual release tag. The migration goes with it, and the site's routes
  for `/mcp`, `/oauth/*` and `/.well-known/*`.

## Open for the owner

- The test address's name, and adding it to the sign-in service's trusted domains (Q21).
- After release 1b: Kids Corner's tidy and split as the first job (Q35), run by the owner from their
  Claude.
