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
  receipt: { header: string; footer: string; logo: string | null; showLogo: boolean };
  company: { name: string; brn: string; vat: string; address: string; phone: string };
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
  receipt: { header: "", footer: "Thank you. See you again soon.", logo: null, showLogo: true },
  company: { name: "", brn: "", vat: "", address: "", phone: "" },
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
    kitchenNotes: Array.isArray(d.kitchenNotes) && d.kitchenNotes.some((n) => typeof n === "string" && n.trim())
      ? (d.kitchenNotes as unknown[]).filter((n): n is string => typeof n === "string" && n.trim() !== "").map((n) => n.trim()).slice(0, 12)
      : DEFAULT_SETTINGS.kitchenNotes,
    prepMinutes: typeof d.prepMinutes === "number" && d.prepMinutes >= 1 && d.prepMinutes <= 180 ? Math.round(d.prepMinutes) : 15,
    lockMinutes: typeof d.lockMinutes === "number" && d.lockMinutes >= 0 && d.lockMinutes <= 120 ? Math.round(d.lockMinutes) : 0,
    kitchenSound: d.kitchenSound === false ? false : true,
    receipt: {
      header: str(r.header, DEFAULT_SETTINGS.receipt.header),
      footer: str(r.footer, DEFAULT_SETTINGS.receipt.footer),
      logo: typeof r.logo === "string" && r.logo.startsWith("data:image/") ? r.logo : null,
      showLogo: r.showLogo === false ? false : true,
    },
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

// Money the way the restaurant set it: Rs 1,250 / Rs 1,250.0 / Rs 1,250.00.
export function money(cents: number, decimals: number = 2): string {
  const v = Number(cents) / 100;
  return (
    (v < 0 ? "-" : "") +
    "Rs " +
    Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  );
}
