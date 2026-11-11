"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePerm } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { act, Refused, text, UUID, uuid } from "@/lib/action";
import { formBranch } from "@/lib/branch";
import { parseRs } from "@/lib/money";
import { loadSettings } from "@/lib/settings";
import { lineFits } from "@/lib/invoice-money";
import { type CustomerHit, findCustomers, findProducts, type Found, glance, type Glance, PATH, stockOf } from "./data";

// What the Invoices pages change (docs/superpowers/specs/2026-11-12-invoices-design.md). Every change needs
// "Make and issue invoices" (invoices.manage); the database checks the rest again (0159).

const PERM = "invoices.manage";

// What the database refuses, in a sentence the owner can act on.
export async function problemOf(msg: string): Promise<string> {
  const m = /invoice-[a-z-]+/.exec(msg)?.[0] ?? "";
  const said: Record<string, string> = {
    "invoice-issued": "This invoice is issued: it can no longer be changed. A mistake on it is put right with a credit note.",
    "invoice-changed": "This draft was changed in another window. Reload the page to see the latest.",
    "invoice-gone": "This invoice no longer exists. Reload the page.",
    "invoice-branch": "Pick the branch the invoice is from.",
    "invoice-customer": "That customer no longer exists. Pick another.",
    "invoice-terms": "Those payment terms are not ones the invoice knows.",
    "invoice-lines": "An invoice holds at most 500 lines.",
    "invoice-mra": "This business sends its invoices to the MRA through its tills, which cannot take invoices from the back office yet. Keep it as a draft for now.",
    "invoice-buyer": "Say who the invoice is for.",
    "invoice-brn": "A business or a government buyer needs their BRN on the invoice.",
    "invoice-empty": "Add at least one line with a price.",
    "invoice-line-blank": "A line has no quantity or no description. Fill it in or take it off.",
    "invoice-future": "An invoice cannot be dated after today.",
    "invoice-due": "Pick the day it is due, on or after the invoice's date.",
    "invoice-date-order": "This branch has already issued an invoice dated later. Date this one on or after it, so numbers and dates go up together.",
    "invoice-number-used": "That number is used already. Check where this branch's numbers start.",
    "invoice-not-issued": "Only an issued invoice takes payments.",
    "invoice-pay-amount": "Type the amount received.",
    "invoice-overpaid": "That is more than the invoice still owes.",
    "invoice-pay-method": "Say how it was paid.",
    "invoice-pay-future": "A payment cannot be dated after today.",
    "invoice-pay-early": "A payment cannot be dated before the invoice.",
    "invoice-prefix": "A prefix is up to 16 letters, digits, dashes, dots or slashes.",
    "invoice-prefix-used": "Another branch uses that prefix. Give each branch its own, so no two invoices share a number.",
    "invoice-series-started": "This branch has issued invoices: its prefix and its first number can no longer change.",
    "invoice-start": "The first number is a whole number from 1.",
  };
  if (said[m]) return said[m];
  if (msg.startsWith("Forbidden")) return "Your role cannot make invoices. The owner can tick it under Roles and permissions.";
  if (msg.includes("suspended")) return msg;
  return "That could not be saved. Nothing was changed.";
}

// `code` is the database's own word for the refusal (invoice-changed, invoice-mra...), for the editor to act on
type Result<T> = ({ ok: true } & T) | { ok: false; error: string; code: string };

async function attempt<T>(fn: (c: import("pg").PoolClient, ctx: Awaited<ReturnType<typeof requirePerm>>) => Promise<T>, perm = PERM): Promise<Result<T>> {
  try {
    const ctx = await requirePerm(perm);
    const out = await withTenant(ctx.tenantId, (c) => fn(c, ctx));
    return { ok: true, ...out };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof Refused) return { ok: false, error: e.message, code: "" };
    const msg = e instanceof Error ? e.message : "";
    return { ok: false, error: await problemOf(msg), code: /invoice-[a-z-]+/.exec(msg)?.[0] ?? "" };
  }
}

// ---- a new draft ----
export async function newInvoice(f: FormData) {
  let to = PATH;
  try {
    const ctx = await requirePerm(PERM);
    const made = await withTenant(ctx.tenantId, async (c) => {
      const store = await formBranch(c, ctx.tenantId, f.get("store"));
      if (!store) throw new Refused("Pick the branch the invoice is from.");
      const customer = String(f.get("customer") ?? "");
      const head = UUID.test(customer) ? await headFor(c, ctx.tenantId, customer) : {};
      return (await c.query(`select invoice_save($1, $2, null, $3, null, $4::jsonb, '[]'::jsonb) as r`, [ctx.tenantId, ctx.employeeId, store, JSON.stringify(head)])).rows[0].r as { id: string };
    });
    to = `${PATH}/${made.id}`;
  } catch (e) {
    unstable_rethrow(e);
    const why = e instanceof Refused ? e.message : await problemOf(e instanceof Error ? e.message : "");
    redirect(`${PATH}?err=${encodeURIComponent(why)}`);
  }
  redirect(to);
}

// a customer's invoice details, as a new invoice for them starts
async function headFor(c: import("pg").PoolClient, tenantId: string, customer: string) {
  const r = (
    await c.query(
      `select cu.id, cu.name, cu.phone, cu.email, d.buyer_type, d.address, d.brn, d.vat_no, d.lang, d.email_cc, d.contact, d.deliver_to, d.terms
         from customers cu left join invoice_customers d on d.tenant_id = cu.tenant_id and d.customer_id = cu.id
        where cu.tenant_id = $1 and cu.id = $2 and cu.deleted_at is null`,
      [tenantId, customer],
    )
  ).rows[0];
  if (!r) return {};
  return {
    customer_id: r.id, buyer_name: r.name, buyer_phone: r.phone, buyer_email: r.email, buyer_type: r.buyer_type ?? "B2C",
    buyer_address: r.address, buyer_brn: r.brn, buyer_vat: r.vat_no, lang: r.lang ?? undefined, buyer_cc: r.email_cc,
    buyer_contact: r.contact, deliver_to: r.deliver_to, terms: r.terms ?? undefined,
  };
}

// ---- the editor's own saves ----
export type SentLine = {
  kind: "line" | "heading" | "note";
  item_id: string | null;
  variant_id: string | null;
  name: string;
  detail: string;
  sku: string | null;
  qty: number;
  unit_price: number;
  list_price: number | null;
  tax_ids: string[];
};
export type SentHead = Record<string, string | number | boolean | null>;
export type Saved = { rev: number; subtotal: number; discount_total: number; tax_added: number; tax_total: number; total: number; due_on: string };

function checkLines(lines: SentLine[]) {
  if (!Array.isArray(lines) || lines.length > 500) throw new Refused("An invoice holds at most 500 lines.");
  for (const l of lines) {
    if (!["line", "heading", "note"].includes(l.kind)) throw new Refused("A line could not be read. Reload the page.");
    if (l.item_id !== null && !UUID.test(l.item_id)) throw new Refused("A line could not be read. Reload the page.");
    if (l.variant_id !== null && !UUID.test(l.variant_id)) throw new Refused("A line could not be read. Reload the page.");
    if (!Number.isInteger(l.qty) || !Number.isInteger(l.unit_price) || l.qty < 0 || l.unit_price < 0) throw new Refused("A quantity or a price is not a number.");
    if (!lineFits(l.unit_price, l.qty)) throw new Refused(`The line "${l.name.slice(0, 40)}" is too large for one line. Split it.`);
    if (!Array.isArray(l.tax_ids) || l.tax_ids.some((t) => !UUID.test(t))) throw new Refused("A line's VAT could not be read. Reload the page.");
  }
}
const UUID_FIELDS = ["customer_id", "rep_id", "store_id"];
function checkHead(h: SentHead) {
  for (const k of UUID_FIELDS) if (h[k] !== undefined && h[k] !== null && h[k] !== "" && !UUID.test(String(h[k]))) throw new Refused("The invoice could not be read. Reload the page.");
  for (const k of ["issued_on", "due_on"]) if (h[k] && !/^\d{4}-\d{2}-\d{2}$/.test(String(h[k]))) throw new Refused("A date could not be read.");
}

export async function saveDraft(id: string, rev: number, head: SentHead, lines: SentLine[]): Promise<Result<Saved>> {
  return attempt(async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("This invoice no longer exists. Reload the page.");
    checkHead(head);
    checkLines(lines);
    const r = (await c.query(`select invoice_save($1, $2, $3, null, $4, $5::jsonb, $6::jsonb) as r`, [ctx.tenantId, ctx.employeeId, id, rev, JSON.stringify(head), JSON.stringify(lines)])).rows[0].r;
    return { rev: r.rev, subtotal: Number(r.subtotal), discount_total: Number(r.discount_total), tax_added: Number(r.tax_added), tax_total: Number(r.tax_total), total: Number(r.total), due_on: r.due_on };
  });
}

// Issue: what is on the page is saved first, then numbered and locked, in one transaction.
export async function issueInvoice(id: string, rev: number, head: SentHead, lines: SentLine[]): Promise<Result<{ number: string }>> {
  const out = await attempt(async (c, ctx) => {
    if (!UUID.test(id)) throw new Refused("This invoice no longer exists. Reload the page.");
    checkHead(head);
    checkLines(lines);
    const s = (await c.query(`select invoice_save($1, $2, $3, null, $4, $5::jsonb, $6::jsonb) as r`, [ctx.tenantId, ctx.employeeId, id, rev, JSON.stringify(head), JSON.stringify(lines)])).rows[0].r;
    const r = (await c.query(`select invoice_issue($1, $2, $3, $4) as r`, [ctx.tenantId, ctx.employeeId, id, s.rev])).rows[0].r;
    return { number: r.number as string };
  });
  if (out.ok) {
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
  }
  return out;
}

export async function deleteDraft(f: FormData) {
  await act(PERM, PATH, async (c, ctx) => {
    const r = await c.query(`update invoices set deleted_at = now() where tenant_id = $1 and id = $2 and status = 'draft' and deleted_at is null`, [ctx.tenantId, uuid(f, "id")]);
    if (r.rowCount !== 1) throw new Refused("Only a draft can be deleted. An issued invoice stays.");
    return "Draft deleted.";
  });
}

// ---- finding things as one types ----
export async function searchProducts(store: string, q: string): Promise<Found[]> {
  const r = await attempt(async (c, ctx) => {
    if (!UUID.test(store)) return { found: [] as Found[] };
    const costs = (await c.query(`select has_perm($1, 'costs.view') as ok`, [ctx.employeeId])).rows[0].ok as boolean;
    return { found: await findProducts(c, ctx.tenantId, q.slice(0, 80), store, costs) };
  });
  return r.ok ? r.found : [];
}

export async function stockFor(store: string, keys: { item_id: string; variant_id: string | null }[]): Promise<Record<string, number | null>> {
  const r = await attempt(async (c, ctx) => {
    const ok = UUID.test(store) && keys.length <= 500 && keys.every((k) => UUID.test(k.item_id) && (k.variant_id === null || UUID.test(k.variant_id)));
    return { stock: ok ? await stockOf(c, ctx.tenantId, store, keys) : {} };
  });
  return r.ok ? r.stock : {};
}

export async function searchCustomers(q: string): Promise<CustomerHit[]> {
  const r = await attempt(async (c, ctx) => ({ found: await findCustomers(c, ctx.tenantId, q.slice(0, 80)) }));
  return r.ok ? r.found : [];
}

export async function customerGlance(id: string): Promise<Glance | null> {
  const r = await attempt(async (c, ctx) => {
    if (!UUID.test(id)) return { g: null };
    const s = await loadSettings(c, ctx.tenantId);
    return { g: await glance(c, ctx.tenantId, id, s.accountDays) };
  });
  return r.ok ? r.g : null;
}

// A customer added from the invoice: a customer like any other, on the tills after their next sync.
export async function addCustomer(name: string, phone: string, email: string): Promise<Result<{ customer: CustomerHit }>> {
  return attempt(async (c, ctx) => {
    const n = name.trim().slice(0, 120);
    if (!n) throw new Refused("A customer needs a name.");
    const r = (
      await c.query(`insert into customers (tenant_id, name, phone, email) values ($1, $2, $3, $4) returning id, name, phone, email`, [
        ctx.tenantId, n, phone.trim().slice(0, 40) || null, email.trim().slice(0, 120) || null,
      ])
    ).rows[0];
    return { customer: { ...r, details: null } as CustomerHit };
  });
}

// ---- payments ----
const METHODS = ["bank", "cheque", "cash", "card", "mobile", "other"];

export async function recordPayment(f: FormData) {
  const id = String(f.get("id") ?? "");
  const back = `${PATH}/${UUID.test(id) ? id : ""}`;
  await act(PERM, back, async (c, ctx) => {
    const amount = parseRs(String(f.get("amount") ?? ""));
    if (amount === null || amount <= 0) throw new Refused("Type the amount received, in rupees.");
    const method = text(f, "method", 20);
    if (!METHODS.includes(method)) throw new Refused("Say how it was paid.");
    const day = text(f, "day", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Refused("Pick the day it was received.");
    try {
      const r = (await c.query(`select invoice_pay($1, $2, $3, $4::date, $5, $6, $7) as r`, [ctx.tenantId, ctx.employeeId, uuid(f, "id"), day, amount, method, text(f, "reference", 120)])).rows[0].r;
      return Number(r.owed) === 0 ? "Payment recorded. The invoice is paid." : "Payment recorded.";
    } catch (e) {
      throw new Refused(await problemOf(e instanceof Error ? e.message : ""));
    }
  });
}

export async function cancelPayment(f: FormData) {
  const id = String(f.get("id") ?? "");
  await act(PERM, `${PATH}/${UUID.test(id) ? id : ""}`, async (c, ctx) => {
    await c.query(`select invoice_pay_cancel($1, $2, $3)`, [ctx.tenantId, ctx.employeeId, uuid(f, "payment")]);
    return "Payment cancelled. It stays on the invoice, struck through.";
  });
}

// ---- the set-up ----
const TERMS = /^(receipt|eom|[0-9]{1,3})$/;

export async function saveSetup(f: FormData) {
  await act(PERM, `${PATH}?setup=1`, async (c, ctx) => {
    const terms = text(f, "terms", 10);
    const lang = text(f, "lang", 2) === "fr" ? "fr" : "en";
    await c.query(
      `insert into invoice_setup (tenant_id, bank_name, account_name, account_no, swift, terms, lang, footer)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (tenant_id) do update set bank_name = excluded.bank_name, account_name = excluded.account_name, account_no = excluded.account_no,
         swift = excluded.swift, terms = excluded.terms, lang = excluded.lang, footer = excluded.footer`,
      [ctx.tenantId, text(f, "bank_name", 120) || null, text(f, "account_name", 120) || null, text(f, "account_no", 60) || null,
       text(f, "swift", 40) || null, TERMS.test(terms) ? terms : "receipt", lang, text(f, "footer", 600) || null],
    );
    return "Invoice set-up saved.";
  });
}

export async function saveSeries(f: FormData) {
  await act(PERM, `${PATH}?setup=1`, async (c, ctx) => {
    const start = Math.round(Number(String(f.get("start") ?? "")));
    try {
      await c.query(`select invoice_series_set($1, $2, $3, $4)`, [ctx.tenantId, uuid(f, "store"), text(f, "prefix", 16), Number.isFinite(start) ? start : 0]);
    } catch (e) {
      throw new Refused(await problemOf(e instanceof Error ? e.message : ""));
    }
    return "Numbers saved.";
  });
}
