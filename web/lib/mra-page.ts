// The back office's MRA page (phase 3 of docs/superpowers/plans/2026-10-21-mra-e-invoicing-plan.md):
// each till's connection to the MRA, and every invoice the tills sent, with
// the MRA's answer. The page and its CSV ask the same question, so the file
// holds what the page showed. Read-only: nothing here changes what was sent.
// Pure, with no imports, so `node web/lib/mra-page.test.mjs` can ask it.

export const MRA_TYPES = { STD: "Sale", CRN: "Credit note", DRN: "Debit note", PRF: "Pro forma", TRN: "Training" } as const;
export type MraType = keyof typeof MRA_TYPES;

const STATUS_WORDS: Record<string, string> = {
  fiscalised: "Fiscalised",
  waiting: "Waiting to send",
  unsure: "Sent, no answer yet",
  check: "Sent twice, no answer: check it on the till",
  refused: "Refused",
};
export const statusWords = (s: string) => STATUS_WORDS[s] ?? s;

// What the status filter offers: waiting covers the three that have no answer yet.
export const STATUS_FILTERS = { fiscalised: "Fiscalised", waiting: "Waiting for an answer", refused: "Refused" } as const;
export type StatusFilter = keyof typeof STATUS_FILTERS;

export type MraFilters = { store: string | null; till: string | null; type: MraType | null; status: StatusFilter | null; from: string | null; to: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDay = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// What the address asks for, with anything that is not what it should be left out.
export function mraFilters(get: (k: string) => string): MraFilters {
  const id = (k: string) => (UUID.test(get(k)) ? get(k) : null);
  const day = (k: string) => (isDay(get(k)) ? get(k) : null);
  const type = get("type");
  const status = get("status");
  return {
    store: id("store"),
    till: id("till"),
    type: Object.hasOwn(MRA_TYPES, type) ? (type as MraType) : null,
    status: Object.hasOwn(STATUS_FILTERS, status) ? (status as StatusFilter) : null,
    from: day("from"),
    to: day("to"),
  };
}

// The same filters, as the end of an address.
export function mraQuery(f: MraFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? "?" + s : "";
}

// A credit note gives money back, so it reads with a minus, though the MRA
// holds it as a positive figure. Cents, or null when there is no figure.
export function signedCents(type: string, paid: string | null): number | null {
  if (paid === null || paid === "") return null;
  const n = Number(paid);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return type === "CRN" ? -Math.abs(cents) : cents;
}

// The MRA's reasons for a refusal, or its warnings, as one line.
export const reasons = (list: unknown): string => (Array.isArray(list) ? list.map(String).join("; ") : "");

// A till's invoices waiting longer than this are a worry.
export const WAITING_HOURS = 2;

export type TillAttention = {
  connected: boolean;
  refusedLogin: string | null;
  waiting: number;
  oldestWaiting: Date | null;
  check: number;
  countedAsTest: boolean;
};

// Why a till is at the top of the page; none when it is fine.
export function attention(t: TillAttention, now: Date): string[] {
  const out: string[] = [];
  if (t.refusedLogin) out.push(`The MRA refused its login: ${t.refusedLogin}`);
  else if (!t.connected) out.push("Not signed in to the MRA");
  if (t.countedAsTest) out.push("The MRA counts its sales as TEST");
  if (t.check > 0) out.push(`${t.check} sent twice with no answer: check them on the till`);
  if (t.waiting > 0 && t.oldestWaiting && now.getTime() - t.oldestWaiting.getTime() > WAITING_HOURS * 3_600_000) {
    out.push(`${t.waiting} waiting for more than ${WAITING_HOURS} hours`);
  }
  return out;
}

// One line of the CSV: a cell with a comma, semicolon, quote or line break is quoted.
export function csvLine(cells: unknown[]): string {
  return cells
    .map((v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

export type MraTillRow = {
  id: string; name: string; code: string; store_id: string; store: string; tz: string; ebs: string | null;
  status: Record<string, unknown> | null; waiting: number; oldest_waiting: string | null; to_check: number;
  last_fiscalised: string | null; refused: number;
};

// $1 tenant. Every till of the business, by branch, with what its invoices say.
export const TILLS_SQL = `
  select d.id, d.name, d.code, s.id as store_id, s.name as store, s.timezone as tz, d.mra_ebs_id as ebs, d.mra_status as status,
         coalesce(w.waiting, 0) as waiting, w.oldest_waiting, coalesce(w.to_check, 0) as to_check,
         w.last_fiscalised, coalesce(w.refused, 0) as refused
    from pos_devices d
    join stores s on s.tenant_id = d.tenant_id and s.id = d.store_id
    left join lateral (
      select count(*) filter (where m.status in ('waiting', 'unsure', 'check'))::int as waiting,
             min(m.issued_at) filter (where m.status in ('waiting', 'unsure', 'check')) as oldest_waiting,
             count(*) filter (where m.status = 'check')::int as to_check,
             max(m.answered_at) filter (where m.status = 'fiscalised') as last_fiscalised,
             count(*) filter (where m.status = 'refused')::int as refused
        from mra_records m
       where m.tenant_id = d.tenant_id and m.device_id = d.id and m.deleted_at is null
    ) w on true
   where d.tenant_id = $1 and d.deleted_at is null
   order by lower(s.name), lower(d.name), d.code`;

export type MraInvoiceRow = {
  id: string; at: string; type: string; identifier: string; ref: string | null; status: string; paid: string | null;
  errors: unknown; warnings: unknown; irn: string | null; qr: string | null; differs: unknown;
  store: string; tz: string; till: string; till_code: string | null;
};

// $1 tenant, $2 branch, $3 till, $4 type, $5 status (fiscalised, waiting, refused), $6 from, $7 to (days in
// the branch's time zone), $8 how many, $9 with the QR picture (the CSV leaves it out). An invoice whose till or
// branch was removed is still listed.
export const INVOICES_SQL = `
  select m.id, m.issued_at as at, m.doc_type as type, m.identifier, m.ref_identifier as ref, m.status,
         (m.invoice::jsonb)->>'totalAmtPaid' as paid, m.errors, m.warnings, m.irn,
         case when $9::boolean then m.qr end as qr, m.differs,
         coalesce(s.name, 'A branch no longer there') as store, coalesce(s.timezone, 'Indian/Mauritius') as tz,
         coalesce(d.name, 'A till no longer set up') as till, d.code as till_code
    from mra_records m
    left join stores s on s.tenant_id = m.tenant_id and s.id = m.store_id
    left join pos_devices d on d.tenant_id = m.tenant_id and d.id = m.device_id
   where m.tenant_id = $1 and m.deleted_at is null
     and ($2::uuid is null or m.store_id = $2::uuid)
     and ($3::uuid is null or m.device_id = $3::uuid)
     and ($4::text is null or m.doc_type = $4::text)
     and ($5::text is null or (case when m.status in ('unsure', 'check') then 'waiting' else m.status end) = $5::text)
     and ($6::date is null or (m.issued_at at time zone coalesce(s.timezone, 'Indian/Mauritius'))::date >= $6::date)
     and ($7::date is null or (m.issued_at at time zone coalesce(s.timezone, 'Indian/Mauritius'))::date <= $7::date)
   order by m.issued_at desc, m.counter desc
   limit $8`;

export const invoiceParams = (tenantId: string, f: MraFilters, limit: number, withQr: boolean) =>
  [tenantId, f.store, f.till, f.type, f.status, f.from, f.to, limit, withQr];
