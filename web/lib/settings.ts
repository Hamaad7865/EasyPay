import type { PoolClient } from "pg";

// A restaurant's settings: one JSON row (pos_settings.data). A key that is
// missing means "as before", so every reader goes through withDefaults.
export type PosSettings = {
  decimals: 0 | 1 | 2;
  billNumbering: "continuous" | "reset";
  dayCloseDetailed: boolean;
  // what the quick payment key beside the register's keypad takes
  quickPay: "card" | "cash";
  // a service charge on orders served at a table, in percent; 0 is none
  servicePct: number;
  // the notes a waiter can tick when adding an item ("No onion", "Rush")
  kitchenNotes: string[];
  // minutes after it is rung up that a takeaway is due (a delivery gets twice that)
  prepMinutes: number;
  // minutes without a touch after which a till locks itself; 0 is never
  lockMinutes: number;
  // a short sound on the kitchen display when an order arrives
  kitchenSound: boolean;
  // one printer does everything: kitchen orders print on the receipt printer, whatever the categories say
  onePrinter: boolean;
  // the till's drawer is counted note by note and coin by coin, in place of typing the amount
  drawerByNotes: boolean;
  // guests order from the code on their table's card (lib/guest.ts). A page of
  // the premium tier: the till service gives the same answer (guest_pass, 0093)
  tableOrdering: boolean;
  // A shop's return policy (migration 0109): exchange (no money back), credit
  // (an exchange's rest goes on a credit note) or refund. Days inside which
  // whoever is at the till returns alone (0: the right to refund is always
  // needed), and months a credit note is valid (0: never expires).
  returns: "exchange" | "credit" | "refund";
  returnDays: number;
  noteMonths: number;
  // A shop's promotions (migration 0110): days without a sale that make a
  // product a slow mover, and days a promotion may sit unsold before it is
  // flagged to be reduced again.
  slowMoverDays: number;
  promoStillDays: number;
  // minutes before an order for later is due that the tills ring (migration 0111); 0 is off
  dueReminderMinutes: number;
  // A shop's deposits (migration 0113): taken or not; what a cancel does with
  // the money (refund, credit note, keep); the collect-by date offered, in
  // days; past it only marked or cancelled after the grace days; whether a
  // customer's name and phone are needed. Whether the shop has the extra at
  // all is has_feature on the server, not a setting.
  deposits: "on" | "off";
  depositCancel: "refund" | "credit" | "keep";
  depositDays: number;
  depositOverdue: "show" | "cancel";
  depositGrace: number;
  depositCustomer: "required" | "optional";
  // A shop's customer accounts (migration 0114): selling on account on or
  // off, and after how many days a bill is overdue. Whether the shop has the
  // extra at all is has_feature on the server, not a setting.
  accounts: "on" | "off";
  accountDays: number;
  // Loyalty points (migration 0128), for every business on every plan: off
  // until switched on; what comes back, in basis points (100 is 1%).
  loyalty: "on" | "off";
  loyaltyBp: number;
  receipt: { header: string; footer: string; logo: string | null; showLogo: boolean };
  company: { name: string; brn: string; vat: string; address: string; phone: string };
  // The receipt's and the kitchen ticket's designs (Receipt design, lib/papers.ts), as kept:
  // read with readDesign, saved with savePaper. A paper not there prints EasyPay's.
  papers: { receipt?: unknown; kitchen?: unknown };
};

export const DEFAULT_SETTINGS: PosSettings = {
  decimals: 2,
  billNumbering: "continuous",
  dayCloseDetailed: true,
  quickPay: "card",
  servicePct: 0,
  kitchenNotes: ["No onion", "Less salt", "Nut allergy", "Extra chutney", "Rush"],
  prepMinutes: 15,
  lockMinutes: 0,
  kitchenSound: true,
  onePrinter: false,
  drawerByNotes: false,
  tableOrdering: false,
  returns: "exchange",
  returnDays: 7,
  noteMonths: 6,
  slowMoverDays: 30,
  promoStillDays: 14,
  dueReminderMinutes: 0,
  deposits: "on",
  depositCancel: "credit",
  depositDays: 30,
  depositOverdue: "show",
  depositGrace: 7,
  depositCustomer: "required",
  accounts: "on",
  accountDays: 30,
  loyalty: "off",
  loyaltyBp: 100,
  receipt: { header: "", footer: "Thank you. See you again soon.", logo: null, showLogo: true },
  company: { name: "", brn: "", vat: "", address: "", phone: "" },
  papers: {},
};

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : {});
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);

export function withDefaults(raw: unknown): PosSettings {
  const d = obj(raw);
  const r = obj(d.receipt);
  const c = obj(d.company);
  const dec = d.decimals === 0 || d.decimals === 1 || d.decimals === 2 ? d.decimals : DEFAULT_SETTINGS.decimals;
  return {
    decimals: dec,
    billNumbering: d.billNumbering === "reset" ? "reset" : "continuous",
    dayCloseDetailed: d.dayCloseDetailed === false ? false : true,
    quickPay: d.quickPay === "cash" ? "cash" : "card",
    servicePct: typeof d.servicePct === "number" && d.servicePct >= 0 && d.servicePct <= 30 ? Math.round(d.servicePct) : 0,
    // a list that was saved is the list, an empty one included: only a restaurant that never saved one is offered the usual five
    kitchenNotes: Array.isArray(d.kitchenNotes)
      ? (d.kitchenNotes as unknown[]).filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()).slice(0, 12)
      : DEFAULT_SETTINGS.kitchenNotes,
    prepMinutes: typeof d.prepMinutes === "number" && d.prepMinutes >= 1 && d.prepMinutes <= 180 ? Math.round(d.prepMinutes) : 15,
    lockMinutes: typeof d.lockMinutes === "number" && d.lockMinutes >= 0 && d.lockMinutes <= 120 ? Math.round(d.lockMinutes) : 0,
    kitchenSound: d.kitchenSound === false ? false : true,
    onePrinter: d.onePrinter === true,
    drawerByNotes: d.drawerByNotes === true,
    tableOrdering: d.tableOrdering === true,
    returns: d.returns === "credit" || d.returns === "refund" ? d.returns : "exchange",
    returnDays: typeof d.returnDays === "number" && d.returnDays >= 0 && d.returnDays <= 365 ? Math.round(d.returnDays) : 7,
    noteMonths: typeof d.noteMonths === "number" && d.noteMonths >= 0 && d.noteMonths <= 36 ? Math.round(d.noteMonths) : 6,
    slowMoverDays: typeof d.slowMoverDays === "number" && d.slowMoverDays >= 1 && d.slowMoverDays <= 365 ? Math.round(d.slowMoverDays) : 30,
    promoStillDays: typeof d.promoStillDays === "number" && d.promoStillDays >= 1 && d.promoStillDays <= 365 ? Math.round(d.promoStillDays) : 14,
    dueReminderMinutes: typeof d.dueReminderMinutes === "number" && d.dueReminderMinutes >= 1 && d.dueReminderMinutes <= 120 ? Math.round(d.dueReminderMinutes) : 0,
    deposits: d.deposits === "off" ? "off" : "on",
    depositCancel: d.depositCancel === "refund" || d.depositCancel === "keep" ? d.depositCancel : "credit",
    depositDays: typeof d.depositDays === "number" && d.depositDays >= 1 && d.depositDays <= 365 ? Math.round(d.depositDays) : 30,
    depositOverdue: d.depositOverdue === "cancel" ? "cancel" : "show",
    depositGrace: typeof d.depositGrace === "number" && d.depositGrace >= 0 && d.depositGrace <= 365 ? Math.round(d.depositGrace) : 7,
    depositCustomer: d.depositCustomer === "optional" ? "optional" : "required",
    accounts: d.accounts === "off" ? "off" : "on",
    accountDays: typeof d.accountDays === "number" && d.accountDays >= 1 && d.accountDays <= 365 ? Math.round(d.accountDays) : 30,
    loyalty: d.loyalty === "on" ? "on" : "off",
    loyaltyBp: typeof d.loyaltyBp === "number" && d.loyaltyBp >= 1 && d.loyaltyBp <= 10000 ? Math.round(d.loyaltyBp) : 100,
    receipt: {
      header: str(r.header, DEFAULT_SETTINGS.receipt.header),
      footer: str(r.footer, DEFAULT_SETTINGS.receipt.footer),
      logo: typeof r.logo === "string" && r.logo.startsWith("data:image/") ? r.logo : null,
      showLogo: r.showLogo === false ? false : true,
    },
    papers: obj(d.papers),
    company: {
      name: str(c.name, ""),
      brn: str(c.brn, ""),
      vat: str(c.vat, ""),
      address: str(c.address, ""),
      phone: str(c.phone, ""),
    },
  };
}

export async function loadSettings(c: PoolClient, tenantId: string): Promise<PosSettings> {
  const r = await c.query(`select data from pos_settings where tenant_id = $1 and deleted_at is null`, [tenantId]);
  return withDefaults(r.rows[0]?.data);
}

// Merges a change into the row (creating it for a restaurant that has none).
// The merge is one level deep, so a group (receipt, company) is sent whole.
export async function saveSettings(c: PoolClient, tenantId: string, patch: Partial<PosSettings>): Promise<void> {
  await c.query(
    `insert into pos_settings (tenant_id, data) values ($1, $2::jsonb)
       on conflict (tenant_id) do update set data = pos_settings.data || excluded.data`,
    [tenantId, JSON.stringify(patch)],
  );
}

// One paper's design into `papers`, the other left as it is; null takes it
// out, so it prints EasyPay's. A key of its own, apart from `receipt`: the
// tablets' saves of the receipt's notes and an offline tablet's waiting ones
// leave it alone (docs/superpowers/specs/2026-10-15-receipt-designer-design.md).
export async function savePaper(c: PoolClient, tenantId: string, paper: "receipt" | "kitchen", design: object | null): Promise<void> {
  const now = `coalesce(case when jsonb_typeof(pos_settings.data->'papers') = 'object' then pos_settings.data->'papers' end, '{}'::jsonb)`;
  if (design === null) {
    await c.query(`update pos_settings set data = data || jsonb_build_object('papers', ${now} - $2::text) where tenant_id = $1`, [tenantId, paper]);
    return;
  }
  await c.query(
    `insert into pos_settings (tenant_id, data) values ($1, jsonb_build_object('papers', jsonb_build_object($2::text, $3::jsonb)))
       on conflict (tenant_id) do update set data = pos_settings.data || jsonb_build_object('papers', ${now} || jsonb_build_object($2::text, $3::jsonb))`,
    [tenantId, paper, JSON.stringify(design)],
  );
}

// Money the way the restaurant set it: Rs 1,250 / Rs 1,250.0 / Rs 1,250.00.
export function money(cents: number, decimals: number = 2): string {
  const v = Number(cents) / 100;
  return (
    (v < 0 ? "-" : "") +
    "Rs " +
    Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  );
}
