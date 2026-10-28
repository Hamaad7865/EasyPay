# EasyPay in Claude: a connector for the owner's own Claude

2026-10-29. Asked by the owner after Kids Corner's import went badly: "we will create a connector or mcp,
the owner will connect his claude app to the software. Then for example he will say, import 6 shirt with
category shirt, opening stock 6 … we should be able to do everything, create a new category, delete
everything". Then: "the ai needs to show how it will appear in the android apk for example if I say Please
open stock for Shirt Long Sleeve quantity 5 variant color red, size 3 - 6m, style striped". Every choice
below was settled with the owner in grill-me rounds (Q1 to Q27, all taken as recommended), ending with
"lets use it this way": the owner's Claude subscription is used in Claude itself, through the connector.

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
| Q22 | Kids Corner's tidy is the assistant's first real job on production. Nothing is changed before it. |
| Q23 | The back office chat's component, model and price are decided at the start of piece 3. |
| Q24 | Order: piece 1 (below), then 2 (settings), then 3 (the back office chat). Each piece is released once tested. |
| Q25 | For now the back office has a **Use EasyPay in Claude** page (the address and the steps), and no chat. Piece 3 adds a chat on EasyPay's own AI account, with a cheap model and a monthly allowance per shop. An owner's own API key may sit beside it later. |
| Q26 | The Allow page says, in one line, that Claude will read and change the shop's data as this person, and that what it reads goes to Anthropic under their own Claude account. |
| Q27 | A connection stays until Disconnect, or until the login loses the permission, is removed, or the shop is suspended. While suspended it can still answer questions but changes nothing. |

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

Changes (each returns a **preview card** and changes nothing):
- `add_line`: one new line with its opening stock (the owner's example).
- `change_stock`: add N or count N, with a reason, at a branch.
- `edit_lines`: price, cost, SKU or barcode of one or many lines.
- `edit_product`, `edit_category` (with the verb in the input: new, rename or move): products and
  categories. A new product can come with its options, or with none plus an opening stock (the owner's
  first example: "import 6 shirt with category shirt, opening stock 6").
- `tidy`: one option of one product (Q15, Q16).
- `delete`: lines, a product, or a category (Q10, Q14).
- `restore`: a delete from the log (Q13).

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
  - the tidy of a copy of Kids Corner's values (84 → 58, 12 → 6, one merge).
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
- After release: Kids Corner's tidy as the first job (Q22), run by the owner from their Claude.
