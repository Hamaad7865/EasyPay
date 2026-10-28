import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readTenant } from "@/lib/db";
import type { Who } from "./oauth";
import { appHtml } from "./app-html";
import { cardHtml, CARD_CSS } from "./card";
import { branches, find, gridsOf, lines, pieces, product, rs, spellings, stock, tileOf, tone } from "./catalog";
import { Ask, cancel, confirm, KINDS, No, propose } from "./changes";
import type { Card, HistoryCard, LinesCard, ProductCard } from "./types";

// EasyPay as the tools of the owner's own Claude (spec, Tools). One server is
// made for each request, for the person the request's token is: every
// question is asked as their business, and every change waits for them.

const CARD_URI = "ui://easypay/card";
const MIME = "text/html;profile=mcp-app";
const SHOWN = { ui: { resourceUri: CARD_URI }, "ui/resourceUri": CARD_URI };
// the Confirm, Cancel tools: only a card's own buttons call them; the AI is not given them
const CARD_ONLY = { ui: { resourceUri: CARD_URI, visibility: ["app"] }, "ui/resourceUri": CARD_URI };

const INSTRUCTIONS = `EasyPay is the shop's point of sale. These tools read and change the shop you signed in to, as the person who connected.
- Find before you change: use find to get a product's id, product to see its options, values (with how many lines use each) and stock.
- Pass values by option name, as the product names its options ("Colour", "Age"), even when the owner says another word ("size"): say in your reply which you took.
- Say quantities in pieces and prices in rupees, as the owner says them. EasyPay converts them.
- A change tool never changes anything: it returns a card showing how it will look on the shop's tablet, and the owner presses Confirm on it. You can't confirm. Tell the owner what the card shows and that it waits for them; mention its warnings.
- When a tool answers with a question, ask the owner that question, then call it again with the answer. Never guess a price, a branch or a value that isn't there.
- Answer in the language the owner writes in. Keep the shop's own spellings of names and values.`;

type Result = { content: { type: "text"; text: string }[]; structuredContent?: { html: string }; _meta?: Record<string, unknown>; isError?: boolean };
const shown = (text: string, card: Card | null, code?: string): Result => ({
  content: [{ type: "text", text }],
  ...(card ? { structuredContent: { html: cardHtml(card) } } : {}),
  ...(code ? { _meta: { "easypay/code": code } } : {}),
});
const said = (text: string): Result => ({ content: [{ type: "text", text }] });

async function guarded(run: () => Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof Ask) return said(`EasyPay needs to know: ${e.message}`);
    if (e instanceof No) return { ...said(e.message), isError: true };
    throw e;
  }
}

export function serverFor(w: Who, origin: string): McpServer {
  const s = new McpServer({ name: "easypay", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS });
  const asShop = <T>(fn: (c: Parameters<Parameters<typeof readTenant>[1]>[0]) => Promise<T>) => readTenant(w.tenantId, fn);
  const mayAsk = async (perm: string) =>
    asShop(async (c) => Boolean((await c.query(`select has_perm($1, $2) as ok`, [w.employeeId, perm])).rows[0]?.ok));

  s.registerResource("card", CARD_URI, { mimeType: MIME, description: "An EasyPay card: a product, its stock, or a change waiting for Confirm." }, async (uri: URL) => ({
    contents: [{ uri: uri.href, mimeType: MIME, text: appHtml(CARD_CSS), _meta: { ui: { prefersBorder: false } } }],
  }));

  // ------------------------------------------------------------- questions

  s.registerTool(
    "find",
    {
      title: "Find products",
      description: "Find the shop's products by words in their name, category or brand. Returns each product's id, category path, lines and pieces in stock.",
      inputSchema: z.object({ words: z.string().describe("What the owner called it, e.g. 'shirt long sleeve'") }),
      annotations: { readOnlyHint: true },
    },
    async ({ words }) =>
      guarded(async () => {
        const found = await asShop(async (c) => {
          const ps = await find(c, w.tenantId, words);
          const store = (await branches(c, w.tenantId))[0];
          return Promise.all(ps.map(async (p) => {
            const ls = await lines(c, w.tenantId, p.id);
            const held = store ? await stock(c, w.tenantId, p.id, store.id) : new Map<string, number>();
            return { ...p, lines: ls.length, pieces: p.counted ? pieces(ls.length ? ls.reduce((a, l) => a + (held.get(l.id) ?? 0), 0) : held.get("") ?? 0) : "not counted" };
          }));
        });
        if (!found.length) return said(`No product of ${w.tenantName} matches "${words}".`);
        const exact = found.filter((f) => f.exact);
        return said(
          (exact.length === 1 ? `"${words}" is ${exact[0].name}.\n` : `No product is called exactly "${words}". Ask the owner which they mean.\n`) +
            found.map((f) => `- ${f.name} (id ${f.id})${f.path ? `, in ${f.path}` : ""}, ${f.lines} lines, ${f.pieces} in stock, ${rs(f.price)}`).join("\n"),
        );
      }),
  );

  s.registerTool(
    "product",
    {
      title: "Show a product",
      description: "One product with its options, each value and how many lines use it, and its stock by line as a grid. Use before changing it.",
      inputSchema: z.object({ product: z.string().describe("The product's id, from find"), branch: z.string().optional().describe("A branch name, when the shop has several") }),
      annotations: { readOnlyHint: true },
      _meta: SHOWN,
    },
    async ({ product: id, branch }) =>
      guarded(async () => {
        const out = await asShop(async (c) => {
          const p = await product(c, w.tenantId, id);
          if (!p) throw new No("That product is not there any more.");
          const all = await branches(c, w.tenantId);
          const store = all.find((b) => b.name.toLowerCase() === (branch ?? "").toLowerCase()) ?? all[0];
          const ls = await lines(c, w.tenantId, p.id);
          const held = store ? await stock(c, w.tenantId, p.id, store.id) : new Map<string, number>();
          const spelled = spellings(p.options, ls);
          const card: ProductCard = {
            kind: "product",
            tile: tileOf(p, ls, held),
            path: p.path,
            options: p.options.map((name, i) => ({ name, values: spelled[i] })),
            grids: gridsOf(p, ls, held),
            branch: store?.name ?? "",
            plain: p.options.length < 2 ? ls.map((l) => ({ line: l.name, qty: pieces(held.get(l.id) ?? 0), tone: tone(held.get(l.id) ?? 0) })) : [],
          };
          const prices = [...new Set(ls.map((l) => l.price))].sort((a, b) => a - b);
          const text = [
            `${p.name} (id ${p.id})${p.path ? `, in ${p.path}` : ""}${p.brand ? `, brand ${p.brand}` : ""}. ${ls.length} lines. Stock at ${store?.name}: ${card.tile.pieces ?? "not counted"}.`,
            prices.length ? `Prices: ${prices.length === 1 ? rs(prices[0]) : `${rs(prices[0])} to ${rs(prices[prices.length - 1])}`}.` : `Price ${rs(p.price)}.`,
            ...p.options.map((o, i) => `${o}: ${spelled[i].map((v) => `${v.value} (${v.lines})`).join(", ")}`),
            ...ls.filter((l) => (held.get(l.id) ?? 0) < 0).map((l) => `Below zero: ${l.name} ${pieces(held.get(l.id) ?? 0)} (line id ${l.id})`),
            ls.length <= 60 ? `Lines: ${ls.map((l) => `${l.name} = ${pieces(held.get(l.id) ?? 0)} [${l.id}]`).join("; ")}` : `Ask stock with this product to list its lines.`,
          ].join("\n");
          return { text, card };
        });
        return shown(out.text, out.card);
      }),
  );

  s.registerTool(
    "stock",
    {
      title: "Stock lines",
      description: "Stock by line: one product's lines (optionally only those with a value, e.g. Colour Red), or every line below zero, or running low (2 or fewer).",
      inputSchema: z.object({
        product: z.string().optional().describe("A product id, from find"),
        value: z.string().optional().describe("Only lines with this value, e.g. 'Red'"),
        which: z.enum(["all", "below_zero", "low"]).optional(),
        branch: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
      _meta: SHOWN,
    },
    async ({ product: id, value, which, branch }) =>
      guarded(async () => {
        if (!(await mayAsk("stock.view")) && !(await mayAsk("items.edit"))) throw new No("Your role doesn't include seeing stock.");
        const out = await asShop(async (c) => {
          const all = await branches(c, w.tenantId);
          const store = all.find((b) => b.name.toLowerCase() === (branch ?? "").toLowerCase()) ?? all[0];
          const r = await c.query(
            `select i.name as product, coalesce(v.name, i.name) as line, v.id as line_id, l.qty
               from stock_levels l join items i on i.id = l.item_id and i.deleted_at is null
               left join item_variants v on v.id = l.variant_id
              where l.tenant_id = $1 and l.store_id = $2 and l.deleted_at is null and (l.variant_id is null or v.deleted_at is null)
                and ($3::uuid is null or l.item_id = $3::uuid)
                and ($4::text = 'all' or ($4 = 'below_zero' and l.qty < 0) or ($4 = 'low' and l.qty between 1 and 2000))
              order by l.qty, i.name, v.name limit 400`,
            [w.tenantId, store.id, id ?? null, which ?? (id ? "all" : "below_zero")],
          );
          const want = (value ?? "").trim().toLowerCase();
          const rows = r.rows.filter((x) => !want || String(x.line).toLowerCase().split(" / ").includes(want));
          const card: LinesCard = {
            kind: "lines",
            title: id ? `Stock at ${store.name}` : which === "low" ? `Running low at ${store.name}` : `Below zero at ${store.name}`,
            rows: rows.slice(0, 120).map((x) => ({ product: x.product, line: x.line, branch: store.name, qty: pieces(Number(x.qty)), tone: tone(Number(x.qty)) })),
            more: Math.max(0, rows.length - 120),
          };
          return { card, text: rows.length ? rows.slice(0, 120).map((x) => `${x.product} ${x.line}: ${pieces(Number(x.qty))} [${x.line_id ?? ""}]`).join("\n") : "Nothing." };
        });
        return shown(out.text, out.card);
      }),
  );

  s.registerTool(
    "history",
    {
      title: "A line's stock history",
      description: "One line's stock movements, newest first: opening, sales, received, found, damaged, counts, transfers, with who and when.",
      inputSchema: z.object({ line: z.string().describe("The line's id (from product or stock)"), older: z.number().optional().describe("How many to skip, for older moves") }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: CARD_URI, visibility: ["model", "app"] }, "ui/resourceUri": CARD_URI },
    },
    async ({ line, older }) =>
      guarded(async () => {
        if (!(await mayAsk("stock.view")) && !(await mayAsk("items.edit"))) throw new No("Your role doesn't include seeing stock.");
        const out = await asShop(async (c) => {
          const l = (await c.query(`select v.id, v.name, v.item_id, i.name as product from item_variants v join items i on i.id = v.item_id where v.tenant_id = $1 and v.id = $2`, [w.tenantId, line])).rows[0];
          if (!l) throw new No("That line isn't there.");
          const r = await c.query(
            `select to_char(m.created_at at time zone s.timezone, 'DD Mon YYYY HH24:MI') as at, m.reason, m.qty, s.name as branch, e.name as who, m.note,
                    (select number from receipts r where r.id = m.receipt_id) as receipt
               from stock_movements m join stores s on s.id = m.store_id left join employees e on e.id = m.employee_id
              where m.tenant_id = $1 and m.variant_id = $2 and m.deleted_at is null
              order by m.created_at desc limit 51 offset $3`,
            [w.tenantId, line, older ?? 0],
          );
          const now = (await c.query(`select coalesce(sum(qty), 0)::int as q from stock_levels where tenant_id = $1 and variant_id = $2 and deleted_at is null`, [w.tenantId, line])).rows[0].q;
          const WHAT: Record<string, string> = { opening: "Opening stock", sale: "Sold", refund: "Returned", receive: "Received", found: "Found", damaged: "Damaged", lost: "Lost", expired: "Expired", internal: "Internal use", count: "Counted", transfer_in: "Transfer in", transfer_out: "Transfer out", deposit: "Deposit", deposit_release: "Deposit released", supplier_return: "Back to supplier", adjust: "Adjusted" };
          const card: HistoryCard = {
            kind: "history",
            product: l.product,
            line: l.name,
            now: pieces(now),
            rows: r.rows.slice(0, 50).map((m) => ({ when: m.at, what: WHAT[m.reason] ?? m.reason, qty: `${Number(m.qty) > 0 ? "+" : ""}${pieces(Number(m.qty))}`, branch: m.branch, who: m.who, ref: m.receipt ?? m.note })),
            more: r.rows.length > 50,
          };
          return { card, text: `${l.product} ${l.name}, now ${pieces(now)}:\n` + card.rows.map((m) => `${m.when} ${m.what} ${m.qty} ${m.branch}${m.who ? ` by ${m.who}` : ""}${m.ref ? ` (${m.ref})` : ""}`).join("\n") };
        });
        return shown(out.text, out.card);
      }),
  );

  s.registerTool(
    "categories",
    { title: "Categories", description: "The shop's categories and sub categories, as paths (Shirt › Long Sleeve), with how many products each holds.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () =>
      guarded(async () => {
        const rows = await asShop(async (c) =>
          (await c.query(
            `select k.id, case when p.id is null then k.name else p.name || ' › ' || k.name end as path,
                    (select count(*)::int from items i where i.category_id = k.id and i.deleted_at is null) as n
               from categories k left join categories p on p.id = k.parent_id
              where k.tenant_id = $1 and k.deleted_at is null order by coalesce(p.sort_order, k.sort_order), coalesce(p.name, k.name), k.parent_id nulls first, k.name`,
            [w.tenantId],
          )).rows,
        );
        return said(rows.length ? rows.map((r) => `- ${r.path}: ${r.n} products (id ${r.id})`).join("\n") : "No categories yet.");
      }),
  );

  s.registerTool(
    "sales",
    {
      title: "Sales",
      description: "What sold between two days (the shop's own days, YYYY-MM-DD), by product, best first, with quantities and amounts.",
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) =>
      guarded(async () => {
        if (!(await mayAsk("reports.view"))) throw new No("Your role doesn't include seeing reports.");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Ask("Which days? Say them as dates.");
        const rows = await asShop(async (c) =>
          (await c.query(
            `select rl.name_snapshot as name, sum(case when r.type = 'refund' then -rl.qty else rl.qty end)::int as qty,
                    sum(case when r.type = 'refund' then -1 else 1 end * line_amount(rl.unit_price, rl.qty))::float8 as amount
               from receipts r join stores s on s.id = r.store_id
               join receipt_lines rl on rl.tenant_id = r.tenant_id and rl.receipt_id = r.id
              where r.tenant_id = $1 and (coalesce(r.device_time, r.created_at) at time zone s.timezone)::date between $2::date and $3::date
              group by 1 order by 3 desc limit 40`,
            [w.tenantId, from, to],
          )).rows,
        );
        const total = rows.reduce((a, r) => a + Number(r.amount), 0);
        return said(rows.length ? `Sales ${from} to ${to}: ${rs(total)}.\n` + rows.map((r) => `- ${r.name}: ${pieces(r.qty)} for ${rs(r.amount)}`).join("\n") : `Nothing sold from ${from} to ${to}.`);
      }),
  );

  // --------------------------------------------------------------- changes

  const asked = z.string().optional().describe("The owner's own words for this change, kept in the log");
  const change = (name: string, title: string, description: string, input: z.ZodObject) =>
    s.registerTool(name, { title, description: description + " Changes nothing: returns a card that waits for the owner's Confirm.", inputSchema: input, _meta: SHOWN }, async (args: Record<string, unknown>) =>
      guarded(async () => {
        const { card, code } = await propose(w, name, args, String(args.asked ?? ""), origin);
        const text = [
          `A card shows this change as it will be on the tablet. It waits for ${w.employeeName} to press Confirm (until ${card.expires}).`,
          ...card.readings.map((r) => `- ${r.said} → ${r.is}${r.isNew ? " (NEW: no line says it yet)" : ""}${r.note ? ` (${r.note})` : ""}`),
          ...card.warnings.map((x) => `Warning: ${x.text}`),
          `If the card doesn't show, it can be confirmed here: ${card.link}`,
        ].join("\n");
        return shown(text, card, code);
      }),
    );

  change(
    "add_line",
    "Add a line (variant)",
    "A new line of a product that has options, e.g. Red / 3-6m / stripe, with its opening stock.",
    z.object({
      product: z.string().describe("The product's id, from find"),
      values: z.record(z.string(), z.string()).describe("Each option of the product by its name, with the owner's value, e.g. {\"Colour\": \"red\", \"Age\": \"3 - 6m\", \"Style\": \"striped\"}"),
      qty: z.number().optional().describe("Opening stock, in pieces"),
      price: z.number().optional().describe("Rupees; leave out when the owner didn't say"),
      cost: z.number().optional(),
      sku: z.string().optional(),
      barcode: z.string().optional(),
      branch: z.string().optional(),
      asked,
    }),
  );
  change(
    "change_stock",
    "Change stock",
    "Add to a line's stock (received, found) or take from it (damaged, lost), or set it to a count.",
    z.object({
      product: z.string(),
      values: z.record(z.string(), z.string()).optional().describe("The line, by each option's value; leave out for a product with no options"),
      mode: z.enum(["add", "set"]).describe("add: the qty is added (or taken for damaged/lost); set: there are qty"),
      qty: z.number(),
      reason: z.enum(["received", "found", "damaged", "lost"]).optional(),
      branch: z.string().optional(),
      asked,
    }),
  );
  change(
    "edit_lines",
    "Edit lines",
    "Change the price, cost, SKU or barcode of some or all lines of a product, or one line's values.",
    z.object({
      product: z.string(),
      lines: z.array(z.string()).optional().describe("Line ids"),
      all: z.boolean().optional().describe("Every line of the product"),
      set: z.object({ price: z.number().optional(), cost: z.number().optional(), sku: z.string().optional(), barcode: z.string().optional(), values: z.record(z.string(), z.string()).optional() }),
      asked,
    }),
  );
  change(
    "edit_product",
    "Make or edit a product",
    "verb new: a product, with its options (its lines are added next) or with none and an opening stock. verb edit: rename it, move it to a category (path 'Shirt › Long Sleeve'), change its brand or price.",
    z.object({
      verb: z.enum(["new", "edit"]),
      product: z.string().optional().describe("For edit: its id"),
      name: z.string().optional(),
      category: z.string().optional().describe("A category or a path, 'Shirt › Long Sleeve'"),
      brand: z.string().optional(),
      price: z.number().optional(),
      cost: z.number().optional(),
      options: z.array(z.string()).optional().describe("For new: up to three option names, e.g. Colour, Size"),
      qty: z.number().optional().describe("For new with no options: opening stock in pieces"),
      branch: z.string().optional(),
      asked,
    }),
  );
  change(
    "edit_category",
    "Make, rename or move a category",
    "verb new: a category, or a sub category with under; rename; move (under a category, or on its own with no under).",
    z.object({ verb: z.enum(["new", "rename", "move"]), category: z.string().optional(), name: z.string().optional(), under: z.string().optional(), asked }),
  );
  change(
    "delete",
    "Delete",
    "Delete products, some lines of a product, or a category. Their stock is written off; Restore can bring them back for 30 days.",
    z.object({ what: z.enum(["products", "lines", "category"]), ids: z.array(z.string()), product: z.string().optional().describe("For lines: the product's id"), asked }),
  );
  change(
    "tidy",
    "Tidy an option's spellings",
    "One option of one product: its spellings of one thing made one (white, White → White; stripe, Stripes, Striped → Stripe). Lines that become the same are merged, with their stock.",
    z.object({
      product: z.string(),
      option: z.string().describe("The option's name, e.g. Colour"),
      names: z.record(z.string(), z.string()).optional().describe("Another name for a group than the one proposed, e.g. {\"Military\": \"Militaire\"}"),
      asked,
    }),
  );
  change(
    "rename_option",
    "Rename an option",
    "An option of a product called something else, e.g. Age → Size. The lines' values stay.",
    z.object({ product: z.string(), option: z.string(), to: z.string(), asked }),
  );
  change(
    "split",
    "Split a product",
    "One product into several, by an option (each value its own product) or by groups of values. Lines keep their barcodes, stock and history; the option leaves the new products. Tidy the option first if it has several spellings.",
    z.object({
      product: z.string(),
      by: z.string().describe("The option split on, e.g. Style"),
      names: z.record(z.string(), z.string()).optional().describe("A name for each value's product, e.g. {\"Design\": \"Long Sleeve Design\"}"),
      groups: z.record(z.string(), z.array(z.string())).optional().describe("Instead: each new product's name with the values it takes"),
      category: z.string().optional().describe("Where the new products go, e.g. 'Shirt › Long Sleeve'"),
      asked,
    }),
  );
  change(
    "move",
    "Move lines into another product",
    "Some or all lines of a product into another product, keeping barcodes, stock and history.",
    z.object({ product: z.string(), into: z.string(), lines: z.array(z.string()).optional(), drop: z.string().optional().describe("An option the lines lose on the way"), asked }),
  );
  change(
    "plan",
    "Tidy the stock: a plan",
    "Several changes as one plan with one Confirm, each step worked out on the steps before it. Steps: edit_category, edit_product, tidy, rename_option, split, move, delete, each with the same args as its own tool. EasyPay checks every line and piece is accounted for.",
    z.object({ steps: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })), asked }),
  );
  change(
    "import",
    "Import rows from a file",
    "Rows you read from a file the owner gave you (xlsx, csv), in EasyPay's columns. Prices in rupees, stock in pieces, up to three options per product by name.",
    z.object({
      rows: z.array(
        z.object({
          n: z.number().optional().describe("The row's number in the file"),
          name: z.string(),
          category: z.string().optional(),
          sub_category: z.string().optional(),
          brand: z.string().optional(),
          price: z.number().optional(),
          cost: z.number().optional(),
          stock: z.number().optional(),
          sku: z.string().optional(),
          barcode: z.string().optional(),
          options: z.record(z.string(), z.string()).optional().describe("e.g. {\"Colour\": \"Red\", \"Size\": \"10\"}"),
        }),
      ),
      existing: z.enum(["add", "set"]).optional().describe("For lines that already hold stock: add the file's quantities, or set them to it. Ask the owner when EasyPay asks."),
      asked,
    }),
  );
  change("start_over", "Start over", "While the shop is being set up: hide every product, line and category, to start the catalog again.", z.object({ asked }));
  change("restore", "Restore", "Bring back a delete or a start over, from the change log, within 30 days.", z.object({ change: z.string().describe("The change's id from the log"), asked }));
  void KINDS;

  s.registerTool("confirm", { title: "Confirm", description: "The card's Confirm button.", inputSchema: z.object({ proposal: z.string(), code: z.string() }), _meta: CARD_ONLY }, async ({ proposal, code }) =>
    guarded(async () => {
      const done = await confirm(w, proposal, code);
      return shown(`${done.title}. ${done.lines.join(" ")}`, done);
    }),
  );
  s.registerTool("cancel", { title: "Cancel", description: "The card's Cancel button.", inputSchema: z.object({ proposal: z.string() }), _meta: CARD_ONLY }, async ({ proposal }) =>
    guarded(async () => {
      await cancel(w, proposal);
      return shown("Cancelled. Nothing was changed.", { kind: "done", title: "Cancelled: nothing was changed", lines: [], tile: null, sheet: null });
    }),
  );
  return s;
}
