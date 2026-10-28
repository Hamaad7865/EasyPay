import type { PoolClient } from "pg";
import type { Who } from "./oauth";
import { loadSettings, saveSettings, type PosSettings } from "@/lib/settings";
import { lines, product, rs } from "./catalog";
import { key, cents } from "./words";
import { Ask, No, type Planned, type Ran, type ReKind, type Viewed } from "./reshape";
import type { Reading } from "./types";

// Piece 2 of EasyPay in Claude (spec Q20), and prices, costs and taxes in
// bulk (the owner, 2026-10-29): a product's tax, the shop's taxes, its
// discounts, its promotions, its POS settings, and its staff's roles. Never:
// PINs, passwords, back office logins, printers, tills, the plan, the MRA
// connection, payments. Each is a change like the others: a card, then the
// owner's Confirm.

type Params = Record<string, unknown>;
type C = { c: PoolClient; w: Who; t: string };
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim());
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const quiet = (lines: string[], warnings: Viewed["warnings"] = [], confirm = "Confirm"): Viewed => ({ tile: null, sheet: null, stock: [], warnings, danger: false, confirm, typeName: null, lines });
const pct = (bp: number) => `${(bp / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

async function taxNamed(x: C, said: unknown) {
  const all = (await x.c.query(`select id, name, rate_bp, type, is_default from taxes where tenant_id = $1 and deleted_at is null order by is_default desc, rate_bp desc, name`, [x.t])).rows;
  const s = str(said).toLowerCase().replace(/\s+/g, " ");
  // its own name, then the same letters and digits ("vat 15" is VAT 15%), then a part of it
  const hit = all.find((t) => t.name.toLowerCase() === s) ?? all.find((t) => key(t.name) === key(s)) ?? all.find((t) => s && (t.name.toLowerCase().includes(s) || s.includes(t.name.toLowerCase())));
  if (!hit) throw new Ask(`Which tax? The shop has ${all.map((t) => `${t.name} (${pct(t.rate_bp)}${t.type === "added" ? ", added" : ""})`).join(", ") || "none"}.`);
  return hit as { id: string; name: string; rate_bp: number; type: string; is_default: boolean };
}

// The products a change is for: some ids, or everything in a category (its subs included).
async function productsOf(x: C, input: Params): Promise<{ id: string; name: string; updated_at: string }[]> {
  const ids = Array.isArray(input.products) ? input.products.map(str) : [];
  const cat = str(input.category);
  if (ids.length) return (await x.c.query(`select id, name, updated_at::text from items where tenant_id = $1 and deleted_at is null and id = any($2::uuid[])`, [x.t, ids])).rows;
  if (cat) {
    const [a, b] = cat.split(/\s*[›>]\s*/);
    const k = (
      await x.c.query(
        `select k.id from categories k left join categories p on p.id = k.parent_id where k.tenant_id = $1 and k.deleted_at is null
            and (($3::text is null and k.parent_id is null and lower(k.name) = lower($2)) or ($3::text is not null and lower(p.name) = lower($2) and lower(k.name) = lower($3)))`,
        [x.t, a, b ?? null],
      )
    ).rows[0];
    if (!k) throw new Ask(`There's no category ${cat}.`);
    return (await x.c.query(`select i.id, i.name, i.updated_at::text from items i join categories c on c.id = i.category_id where i.tenant_id = $1 and i.deleted_at is null and (c.id = $2 or c.parent_id = $2)`, [x.t, k.id])).rows;
  }
  throw new Ask("Which products? Give their ids, or a category.");
}

// ------------------------------------------------------------ a product's tax

export const setTax: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const tax = await taxNamed(x, input.tax);
    const ps = await productsOf(x, input);
    if (!ps.length) throw new No("No product is there to give that tax.");
    return {
      params: { tax: tax.id, items: ps.map((p) => p.id), name: tax.name, type: tax.type, rate: tax.rate_bp },
      readings: [{ said: "tax", is: `${tax.name}, ${pct(tax.rate_bp)}${tax.type === "added" ? ", added on top" : ", in the price"}`, note: null, isNew: false }, { said: "products", is: `${ps.length}`, note: ps.slice(0, 5).map((p) => p.name).join(", ") + (ps.length > 5 ? "…" : ""), isNew: false }],
      title: `Tax ${tax.name} on ${ps.length === 1 ? ps[0].name : `${ps.length} products`}`,
      touched: Object.fromEntries(ps.map((p) => [`items:${p.id}`, p.updated_at])),
    };
  },
  async run(x, p) {
    await x.c.query(`update item_taxes set deleted_at = now() where tenant_id = $1 and item_id = any($2::uuid[]) and tax_id <> $3 and deleted_at is null`, [x.t, p.items, p.tax]);
    await x.c.query(
      `insert into item_taxes (tenant_id, item_id, tax_id) select $1, i, $3 from unnest($2::uuid[]) i on conflict (item_id, tax_id) do update set deleted_at = null`,
      [x.t, p.items, p.tax],
    );
    return { summary: "tax set", lines: [] };
  },
  async view(_x, p) {
    return quiet([`${(p.items as string[]).length} products take ${p.name}`], [
      { tone: "amber", text: p.type === "added" ? `${p.name} is added on top: customers pay ${pct(p.rate as number)} more than the shelf price.` : `${p.name} is in the price: shelf prices stay, the VAT inside them is ${pct(p.rate as number)}.` },
    ]);
  },
};

// ---------------------------------------------------------------- the taxes

export const editTax: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const verb = str(input.verb) || "new";
    const rate = num(input.rate);
    const type = str(input.type) === "added" ? "added" : "included";
    if (verb === "new") {
      const name = str(input.name).slice(0, 40);
      if (!name || rate === null) throw new Ask("What is the tax called, and its rate in percent?");
      if (rate < 0 || rate > 100) throw new No("A rate is between 0 and 100 percent.");
      if ((await x.c.query(`select 1 from taxes where tenant_id = $1 and deleted_at is null and lower(name) = lower($2)`, [x.t, name])).rowCount) throw new No(`A tax called ${name} is already there.`);
      return { params: { verb, name, rate: Math.round(rate * 100), type }, readings: [{ said: "tax", is: `${name}, ${rate}%, ${type === "added" ? "added on top" : "in the price"}`, note: "new", isNew: true }], title: `New tax: ${name}`, touched: {} };
    }
    const tax = await taxNamed(x, input.tax);
    const name = str(input.name).slice(0, 40) || tax.name;
    const newRate = rate === null ? tax.rate_bp : Math.round(rate * 100);
    const items = (await x.c.query(`select count(*)::int as n from item_taxes where tenant_id = $1 and tax_id = $2 and deleted_at is null`, [x.t, tax.id])).rows[0].n;
    if (verb === "default") return { params: { verb, id: tax.id, name: tax.name }, readings: [{ said: "usual tax", is: tax.name, note: "new products take it", isNew: false }], title: `${tax.name} as the usual tax`, touched: {} };
    return {
      params: { verb: "edit", id: tax.id, name, rate: newRate, type: input.type ? type : tax.type, was: tax.rate_bp, items },
      readings: [{ said: tax.name, is: `${name}, ${pct(newRate)}`, note: `${items} products have it`, isNew: false }],
      title: `Change tax ${tax.name}`,
      touched: {},
    };
  },
  async run(x, p) {
    if (p.verb === "new") await x.c.query(`insert into taxes (tenant_id, name, rate_bp, type, is_default) values ($1,$2,$3,$4,false)`, [x.t, p.name, p.rate, p.type]);
    else if (p.verb === "default") {
      await x.c.query(`update taxes set is_default = false where tenant_id = $1 and is_default and id <> $2`, [x.t, p.id]);
      await x.c.query(`update taxes set is_default = true where tenant_id = $1 and id = $2`, [x.t, p.id]);
    } else await x.c.query(`update taxes set name = $3, rate_bp = $4, type = $5 where tenant_id = $1 and id = $2`, [x.t, p.id, p.name, p.rate, p.type]);
    return { summary: "tax saved", lines: [] };
  },
  async view(_x, p) {
    const w = p.verb === "edit" && p.rate !== p.was ? [{ tone: "amber" as const, text: `${p.items} products change from ${pct(p.was as number)} to ${pct(p.rate as number)} on their next sale. Receipts already made keep theirs.` }] : [];
    return quiet([`${p.name}${p.rate !== undefined ? `, ${pct(p.rate as number)}` : ""}`], w);
  },
};

// ------------------------------------------------------------- the discounts

export const editDiscount: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const verb = str(input.verb) || "new";
    const all = (await x.c.query(`select id, name, type, value, requires_approval from discounts where tenant_id = $1 and deleted_at is null`, [x.t])).rows;
    const type = str(input.type) === "amount" ? "amount" : "percent";
    const value = num(input.value);
    const said = (t: string, v: number) => (t === "amount" ? rs(v) : `${v}%`);
    if (verb === "new") {
      const name = str(input.name).slice(0, 40);
      if (!name || value === null) throw new Ask("What is the discount called, and how much does it take off (a percent or rupees)?");
      if (type === "percent" && (value <= 0 || value > 100)) throw new No("A percent discount is between 1 and 100.");
      const v = type === "amount" ? cents(value) : Math.round(value);
      return { params: { verb, name, type, value: v, approval: input.approval === true }, readings: [{ said: "discount", is: `${name}, ${said(type, v)} off`, note: input.approval ? "needs a manager" : null, isNew: true }], title: `New discount: ${name}`, touched: {} };
    }
    const d = all.find((x2) => x2.name.toLowerCase() === str(input.discount).toLowerCase()) ?? all.find((x2) => key(x2.name) === key(str(input.discount)));
    if (!d) throw new Ask(`Which discount? The shop has ${all.map((x2) => x2.name).join(", ") || "none"}.`);
    if (verb === "delete") return { params: { verb, id: d.id, name: d.name }, readings: [{ said: "discount", is: d.name, note: "deleted", isNew: false }], title: `Delete discount ${d.name}`, touched: {} };
    const v = value === null ? Number(d.value) : type === "amount" || (input.type === undefined && d.type === "amount") ? cents(value) : Math.round(value);
    const t = input.type === undefined ? d.type : type;
    return { params: { verb: "edit", id: d.id, name: str(input.name) || d.name, type: t, value: v, approval: input.approval === undefined ? d.requires_approval : input.approval === true }, readings: [{ said: d.name, is: `${str(input.name) || d.name}, ${said(t, v)} off`, note: null, isNew: false }], title: `Change discount ${d.name}`, touched: {} };
  },
  async run(x, p) {
    if (p.verb === "new") await x.c.query(`insert into discounts (tenant_id, name, type, value, requires_approval) values ($1,$2,$3,$4,$5)`, [x.t, p.name, p.type, p.value, p.approval]);
    else if (p.verb === "delete") await x.c.query(`update discounts set deleted_at = now() where tenant_id = $1 and id = $2`, [x.t, p.id]);
    else await x.c.query(`update discounts set name = $3, type = $4, value = $5, requires_approval = $6 where tenant_id = $1 and id = $2`, [x.t, p.id, p.name, p.type, p.value, p.approval]);
    return { summary: "discount saved", lines: [] };
  },
  async view(_x, p) {
    return quiet([`${p.name}`], p.verb === "delete" ? [{ tone: "red", text: `The tills stop offering ${p.name} at their next sync.` }] : []);
  },
};

// ------------------------------------------------------------- promotions

// A promoted price on lines of a product (0110): never below cost, so a line
// with no cost can't be promoted; lifted, the price goes back.
export const promote: ReKind = {
  perm: "items.edit",
  async plan(x, input) {
    const p = await product(x.c, x.t, str(input.product));
    if (!p) throw new Ask("Which product? Find it first.");
    const ls = await lines(x.c, x.t, p.id);
    if (str(input.verb) === "lift") {
      const on = (await x.c.query(`select id, variant_id from promotions where tenant_id = $1 and item_id = $2 and status = 'active' and deleted_at is null`, [x.t, p.id])).rows;
      if (!on.length) throw new No(`${p.name} has no promotion running.`);
      return { params: { verb: "lift", ids: on.map((o) => o.id), name: p.name }, readings: [{ said: "lift", is: p.name, note: `${on.length} promoted prices go back`, isNew: false }], title: `Lift the promotion on ${p.name}`, touched: {} };
    }
    const price = num(input.price), off = num(input.percent);
    if (price === null && off === null) throw new Ask("What price, or how many percent off?");
    const targets = ls.length ? ls : [{ id: null as unknown as string, name: p.name, price: p.price, cost: p.cost }];
    const plan = targets.map((l) => ({ line: l.id, name: l.name, was: l.price, cost: l.cost ?? p.cost, now: price !== null ? cents(price) : Math.round((l.price * (100 - (off as number))) / 100) }));
    const bad = plan.filter((l) => l.cost === null || l.now < (l.cost as number));
    if (bad.length) throw new No(`${bad.length} of them ${bad[0].cost === null ? "have no cost, so" : "would go below cost, so"} they can't be promoted (for example ${bad[0].name}). Set a cost first, or a higher price.`);
    return { params: { verb: "apply", item: p.id, plan }, readings: [{ said: "promotion", is: p.name, note: plan.length === 1 ? `${rs(plan[0].was)} → ${rs(plan[0].now)}` : `${plan.length} lines, ${off !== null ? `${off}% off` : rs(cents(price as number))}`, isNew: false }], title: `Promote ${p.name}`, touched: {} };
  },
  async run(x, p) {
    if (p.verb === "lift") {
      for (const id of p.ids as string[]) await x.c.query(`select promotion_lift($1,$2,$3)`, [x.t, x.w.employeeId, id]);
      return { summary: "promotion lifted", lines: [] };
    }
    for (const l of p.plan as { line: string | null; now: number }[]) await x.c.query(`select promotion_apply($1,$2,$3,$4,$5,$6)`, [x.t, x.w.employeeId, p.item, l.line, l.now, "Through Claude"]);
    return { summary: "promoted", lines: [] };
  },
  async view(_x, p) {
    if (p.verb === "lift") return quiet([`${(p.ids as string[]).length} prices of ${p.name} go back to what they were`]);
    return quiet((p.plan as { name: string; was: number; now: number }[]).map((l) => `${l.name}: ${rs(l.was)} → ${rs(l.now)}`), [{ tone: "amber", text: "The tills sell at the promoted price from their next sync." }]);
  },
};

// ----------------------------------------------------------- POS settings

// What a shop may change through Claude, each with its words and what it takes.
type Rule = { label: string; set: (v: unknown) => Partial<PosSettings> | null; show: (s: PosSettings) => string };
const one = <T extends string>(v: unknown, ok: T[]) => (ok.includes(str(v) as T) ? (str(v) as T) : null);
const whole = (v: unknown, lo: number, hi: number) => { const n = num(v); return n !== null && Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
const RULES: Record<string, Rule> = {
  returns: { label: "Returns (exchange, credit or refund)", set: (v) => { const r = one(v, ["exchange", "credit", "refund"]); return r ? { returns: r } : null; }, show: (s) => s.returns },
  returnDays: { label: "Days to return", set: (v) => { const n = whole(v, 0, 365); return n === null ? null : { returnDays: n }; }, show: (s) => String(s.returnDays) },
  noteMonths: { label: "Months a credit note lasts (0 never ends)", set: (v) => { const n = whole(v, 0, 60); return n === null ? null : { noteMonths: n }; }, show: (s) => String(s.noteMonths) },
  slowMoverDays: { label: "Days without a sale that make a product slow", set: (v) => { const n = whole(v, 7, 365); return n === null ? null : { slowMoverDays: n }; }, show: (s) => String(s.slowMoverDays) },
  deposits: { label: "Deposits (on or off)", set: (v) => { const r = one(v, ["on", "off"]); return r ? { deposits: r } : null; }, show: (s) => s.deposits },
  depositDays: { label: "Days a deposit holds goods", set: (v) => { const n = whole(v, 1, 365); return n === null ? null : { depositDays: n }; }, show: (s) => String(s.depositDays) },
  accounts: { label: "Selling on account (on or off)", set: (v) => { const r = one(v, ["on", "off"]); return r ? { accounts: r } : null; }, show: (s) => s.accounts },
  accountDays: { label: "Days to pay an account", set: (v) => { const n = whole(v, 1, 365); return n === null ? null : { accountDays: n }; }, show: (s) => String(s.accountDays) },
  loyalty: { label: "Loyalty points (on or off)", set: (v) => { const r = one(v, ["on", "off"]); return r ? { loyalty: r } : null; }, show: (s) => s.loyalty },
  loyaltyPercent: { label: "Loyalty: percent back", set: (v) => { const n = num(v); return n !== null && n >= 0 && n <= 20 ? { loyaltyBp: Math.round(n * 100) } : null; }, show: (s) => pct(s.loyaltyBp) },
  quickPay: { label: "The quick Pay key (cash or card)", set: (v) => { const r = one(v, ["cash", "card"]); return r ? { quickPay: r } : null; }, show: (s) => s.quickPay },
  receiptHeader: { label: "Receipt header text", set: (v) => (typeof v === "string" && v.length <= 300 ? ({ receipt: { header: v } } as Partial<PosSettings>) : null), show: (s) => s.receipt.header || "(none)" },
  receiptFooter: { label: "Receipt footer text", set: (v) => (typeof v === "string" && v.length <= 300 ? ({ receipt: { footer: v } } as Partial<PosSettings>) : null), show: (s) => s.receipt.footer || "(none)" },
};
export const SETTING_NAMES = Object.keys(RULES);
export async function settingsNow(c: PoolClient, t: string): Promise<string[]> {
  const s = await loadSettings(c, t);
  return Object.entries(RULES).map(([k, r]) => `${k}: ${r.show(s)} (${r.label})`);
}

export const changeSettings: ReKind = {
  perm: "settings.device",
  async plan(x, input) {
    const set = (input.set ?? {}) as Record<string, unknown>;
    const now = await loadSettings(x.c, x.t);
    const patch: Partial<PosSettings> = {};
    const readings: Reading[] = [];
    for (const [k, v] of Object.entries(set)) {
      const rule = RULES[k];
      if (!rule) throw new No(`${k} isn't a setting Claude may change. These are: ${SETTING_NAMES.join(", ")}.`);
      const p = rule.set(v);
      if (!p) throw new No(`${String(v)} isn't a value for ${rule.label.toLowerCase()}.`);
      if (p.receipt) p.receipt = { ...now.receipt, ...(patch.receipt ?? {}), ...p.receipt };
      Object.assign(patch, p);
      readings.push({ said: rule.label, is: rule.show({ ...now, ...patch } as PosSettings), note: `was ${rule.show(now)}`, isNew: false });
    }
    if (!readings.length) throw new Ask(`Which setting? ${SETTING_NAMES.join(", ")}.`);
    return { params: { patch }, readings, title: "POS settings", touched: {} };
  },
  async run(x, p) {
    await saveSettings(x.c, x.t, p.patch as Partial<PosSettings>);
    return { summary: "settings saved", lines: [] };
  },
  async view(_x, _p, _ran, before) {
    return quiet(before.readings.map((r) => `${r.said}: ${r.is} (${r.note})`), [{ tone: "amber", text: "The tills take these from their next sync." }]);
  },
};

// ------------------------------------------------------------------ staff

// A staff member's role, or switching them off or on. Never a PIN, a
// password or a back office login's email.
export const editStaff: ReKind = {
  perm: "employees.edit",
  async plan(x, input) {
    const all = (await x.c.query(`select e.id, e.name, e.is_active, r.name as role, r.permissions ? '*' as owner from employees e left join roles r on r.id = e.role_id where e.tenant_id = $1 and e.deleted_at is null`, [x.t])).rows;
    const e = all.find((s) => s.id === str(input.staff)) ?? all.find((s) => s.name.toLowerCase() === str(input.staff).toLowerCase());
    if (!e) throw new Ask(`Who? The staff are ${all.map((s) => s.name).join(", ")}.`);
    if (e.id === x.w.employeeId) throw new No("You can't change your own role or switch yourself off through Claude.");
    const readings: Reading[] = [{ said: "staff", is: e.name, note: e.role, isNew: false }];
    const params: Params = { id: e.id, name: e.name };
    if (str(input.role)) {
      const r = (await x.c.query(`select id, name, permissions ? '*' as owner from roles where tenant_id = $1 and deleted_at is null and lower(name) = lower($2)`, [x.t, str(input.role)])).rows[0];
      if (!r) throw new Ask(`Which role? ${(await x.c.query(`select string_agg(name, ', ' order by name) as n from roles where tenant_id = $1 and deleted_at is null`, [x.t])).rows[0].n}.`);
      if (r.owner) throw new No("Making someone an owner is done in the back office, not through Claude.");
      params.role = r.id;
      readings.push({ said: "role", is: r.name, note: `was ${e.role}`, isNew: false });
    }
    if (typeof input.active === "boolean") {
      if (!input.active && e.owner) throw new No("The owner can't be switched off through Claude.");
      params.active = input.active;
      readings.push({ said: "on the tills", is: input.active ? "on" : "off", note: e.is_active ? "was on" : "was off", isNew: false });
    }
    if (readings.length === 1) throw new Ask("What changes: their role, or on or off?");
    return { params, readings, title: `Staff: ${e.name}`, touched: {} };
  },
  async run(x, p) {
    if (p.role) await x.c.query(`update employees set role_id = $3 where tenant_id = $1 and id = $2`, [x.t, p.id, p.role]);
    if (typeof p.active === "boolean") await x.c.query(`update employees set is_active = $3 where tenant_id = $1 and id = $2`, [x.t, p.id, p.active]);
    return { summary: "staff saved", lines: [] };
  },
  async view(_x, p, _ran, before) {
    return quiet(before.readings.slice(1).map((r) => `${r.said}: ${r.is} (${r.note})`), p.active === false ? [{ tone: "red", text: `${p.name} can't sign in to the tills after their next sync.` }] : []);
  },
};

export const SETTINGS: Record<string, ReKind> = { set_tax: setTax, edit_tax: editTax, edit_discount: editDiscount, promote, settings: changeSettings, edit_staff: editStaff };
export type { Planned, Ran };
