// A client's MRA e-invoicing (migration 0116, docs/superpowers/specs/2026-10-17-premium-mra-design.md).
// Premium MRA is the premium plan with tenants.mra not "off". Pure, so
// `node web/lib/mra.test.mjs` can ask it.

export type MraState = "off" | "setting_up" | "training" | "live";
const STATES: MraState[] = ["off", "setting_up", "training", "live"];

export const asMra = (v: unknown): MraState => (STATES.includes(v as MraState) ? (v as MraState) : "off");
// the MRA details are asked for, and its rules hold, from the moment a client is being moved
export const onMra = (s: MraState) => s !== "off";

export const MRA_STATE_WORDS: Record<MraState, string> = {
  off: "Not on MRA",
  setting_up: "Setting up",
  training: "Training",
  live: "Live",
};

// The MRA's tax codes, one on every line it is sent (the Standard e-Invoice Template).
export const MRA_CODES = [
  ["TC01", "Taxable at 15%"],
  ["TC02", "Taxable at 0% (zero rated)"],
  ["TC03", "Exempt"],
  ["TC04", "Not fiscal, outside turnover"],
  ["TC05", "15% to an exempt body or person"],
  ["TC06", "Outside the scope of VAT"],
] as const;

export const isMraCode = (v: string) => MRA_CODES.some(([c]) => c === v);

// what a tax most likely is, until the owner saves its code
export function suggestCode(rateBp: number, name: string): string | null {
  if (rateBp === 1500) return "TC01";
  if (rateBp === 0) return /exempt/i.test(name) ? "TC03" : "TC02";
  return null;
}

export const NATURES = [
  ["goods", "Goods"],
  ["services", "Services"],
] as const;
export const asNature = (v: unknown): "goods" | "services" | null => (v === "goods" || v === "services" ? v : null);

// One line of mra_checklist (0116), and the same in words.
export type ChecklistLine = { key: string; ok: boolean; missing?: string[]; count?: number };
export type ChecklistWords = { key: string; ok: boolean; title: string; detail: string };

const TITLES: Record<string, string> = {
  company: "Legal name, TAN and BRN",
  nature: "Goods or services: what the business sells",
  addresses: "An address for every branch",
  taxes: "An MRA code for every tax",
  items: "A tax on every item",
  tills: "An EBS MRA ID for every till in use",
  login: "The client's MRA login",
};
const MISSING: Record<string, string> = { company: "Missing", addresses: "No address", taxes: "No code", tills: "No ID" };

export function checklistWords(lines: ChecklistLine[]): ChecklistWords[] {
  const out = lines.map((l) => {
    let detail = "";
    if (!l.ok && l.missing?.length) detail = `${MISSING[l.key] ?? "Missing"}: ${l.missing.join(", ")}.`;
    if (!l.ok && l.key === "items") detail = `${l.count} ${l.count === 1 ? "item has" : "items have"} no tax.`;
    return { key: l.key, ok: l.ok, title: TITLES[l.key] ?? l.key, detail };
  });
  // asked for once the MRA's connection is built (piece 2)
  out.push({ key: "login", ok: false, title: TITLES.login, detail: "Comes with the MRA connection." });
  return out;
}
