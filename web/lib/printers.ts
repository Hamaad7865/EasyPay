// What the Printers page says is worth a second look before service. None of
// it stops the till. It is worked out store by store, because a store prints
// on its own printers: one store with its receipt printer set says nothing
// about the next, and the same address in two stores is two printers. With
// several stores each line names its store.
// Kept apart from the page so that db/tests/backoffice-saves.test.cjs can ask
// it what it would say.

export type PrinterRow = {
  id: string;
  store_id: string;
  name: string;
  // "screen": a kitchen screen (0086), a tablet that shows the orders. It
  // prints nothing, so the page hands this file its printers only.
  kind: "network" | "usb" | "screen";
  address: string | null;
  paper_mm: number;
  is_receipt: boolean;
  feed_lines: number;
  cut: boolean;
  is_active: boolean;
  // a kitchen screen's: the code its tablet shows, and whether it shows every item
  pair_code?: string | null;
  all_items?: boolean;
};
export type PrinterCat = { id: string; name: string; printer_ids: string[] };

// What an order that prints nowhere still does. With the kitchen display (the
// premium tier's) it is on the display; without it, it reaches nobody, and
// the till says so when the order is sent.
const SEEN = "they show on the kitchen display only";
const UNSEEN = "and this plan has no kitchen display for them to show on. The till names them when the order is sent";

// `display`: the restaurant's plan has the kitchen display.
export function printerWarnings(rows: PrinterRow[], cats: PrinterCat[], one: boolean, stores: { id: string; name: string }[], display = true): string[] {
  const many = stores.length > 1;
  return stores.flatMap((s) =>
    storeWarnings(rows.filter((p) => p.store_id === s.id), cats, one, display).map((line) => (many ? `${s.name}: ${line}` : line)),
  );
}

function storeWarnings(rows: PrinterRow[], cats: PrinterCat[], one: boolean, display: boolean): string[] {
  const out: string[] = [];
  if (rows.length === 0) return out;
  const live = rows.filter((p) => p.is_active);
  const receipt = rows.find((p) => p.is_receipt);
  const byId = new Map(rows.map((p) => [p.id, p]));
  if (!receipt) out.push("No printer prints the receipts and bills. Choose one in step 2: until then nothing prints at the till and the cash drawer does not open.");
  else if (!receipt.is_active) out.push(`${receipt.name} prints the receipts and bills, and it is switched off.`);
  if (one && (!receipt || !receipt.is_active)) {
    out.push("One printer for everything is on, but that printer is missing or switched off. Kitchen orders follow the ticks in step 2 until it is back.");
  }
  if (!one) {
    const nowhere = cats.filter((k) => !k.printer_ids.some((id) => byId.get(id)?.is_active));
    if (nowhere.length === cats.length && cats.length > 0) {
      const what = display ? `No category is ticked, so kitchen orders do not print: ${SEEN}.` : `No category is ticked, so kitchen orders do not print, ${UNSEEN}.`;
      out.push(live.length === 1 ? `${what} With a single printer, switch on One printer for everything.` : what);
    } else if (nowhere.length > 0) {
      const names = nowhere.map((k) => k.name).join(", ");
      out.push(display ? `Orders for ${names} print nowhere: ${SEEN}.` : `Orders for ${names} print nowhere, ${UNSEEN}.`);
    }
    for (const p of rows.filter((x) => !x.is_active)) {
      const sent = cats.filter((k) => k.printer_ids.includes(p.id));
      if (sent.length > 0) out.push(`${p.name} is switched off, and ${sent.map((k) => k.name).join(", ")} ${sent.length === 1 ? "is" : "are"} sent to it.`);
    }
  }
  const seen = new Map<string, string>();
  for (const p of live) {
    const key = p.kind === "usb" ? "usb" : (p.address ?? "").includes(":") ? (p.address ?? "") : `${p.address}:9100`;
    const other = seen.get(key);
    if (other) out.push(`${other} and ${p.name} are the same printer (${p.kind === "usb" ? "USB" : p.address}). That works, their prints wait for each other; remove one if it was entered twice by mistake.`);
    else seen.set(key, p.name);
  }
  return out;
}

// Step 2's form holds one choice of receipt printer for each store that has
// printers, in a field that names the store.
const RECEIPT = "receipt_";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const receiptField = (store: string) => RECEIPT + store;

// What the form says: for each store, the printer picked, or null for "No printer".
export function receiptPicks(f: FormData): { store: string; printer: string | null }[] {
  return [...new Set(f.keys())]
    .filter((k) => k.startsWith(RECEIPT) && ID.test(k.slice(RECEIPT.length)))
    .map((k) => {
      const picked = String(f.get(k) ?? "").toLowerCase();
      return { store: k.slice(RECEIPT.length).toLowerCase(), printer: ID.test(picked) ? picked : null };
    });
}
