// A catalog file's cells as the rows the database takes (catalog_import,
// migration 0071): money in cents, quantities in thousandths. Pure, with no
// imports, so the import screen uses it in the browser and its test runs it
// under node; the money reader is handed in (lib/money's parseRs).

// One line of the file. `n` is the row's number in the file (the header is
// row 1); `bad` is a problem found here, which the database then reports
// without looking further at the row.
export type CatalogRow = {
  n: number;
  name?: string; category?: string; brand?: string; supplier?: string; supplier_code?: string;
  o1?: string; v1?: string; o2?: string; v2?: string; o3?: string; v3?: string;
  sku?: string; barcode?: string; tax?: string;
  price?: number | null; cost?: number | null; reorder?: number | null; order_qty?: number | null; stock?: number | null;
  bad?: string;
};

// The columns, by the names a header may carry (its letters and digits only,
// lower case). The template spells them the first way.
const COLUMNS: Record<string, keyof CatalogRow> = {
  name: "name", product: "name", productname: "name",
  category: "category", brand: "brand", supplier: "supplier",
  suppliercode: "supplier_code", supplierscode: "supplier_code",
  option1: "o1", option1name: "o1", value1: "v1", option1value: "v1",
  option2: "o2", option2name: "o2", value2: "v2", option2value: "v2",
  option3: "o3", option3name: "o3", value3: "v3", option3value: "v3",
  sku: "sku", barcode: "barcode",
  price: "price", sellingprice: "price", cost: "cost", costprice: "cost", tax: "tax",
  reorderat: "reorder", reorderlevel: "reorder", reorder: "reorder",
  orderquantity: "order_qty", orderqty: "order_qty",
  openingstock: "stock", stock: "stock", quantity: "stock", instock: "stock",
};
const MONEY = new Set<keyof CatalogRow>(["price", "cost"]);
const QTY = new Set<keyof CatalogRow>(["reorder", "order_qty", "stock"]);

// `cells` is the file as parseCsv gives it, header first. A row with nothing
// in it is skipped. `unknown` are the headers no column answers to; `noName`
// says the file has no Name column at all, so it is not a catalog.
export function toCatalogRows(cells: string[][], money: (s: string) => number | null): { rows: CatalogRow[]; unknown: string[]; noName: boolean } {
  const header = cells[0] ?? [];
  const keys = header.map((h) => COLUMNS[h.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null);
  const unknown = header.filter((h, i) => keys[i] === null && h.trim() !== "");
  const rows: CatalogRow[] = [];
  cells.slice(1).forEach((line, at) => {
    if (line.every((c) => c.trim() === "")) return;
    const r: Record<string, unknown> = { n: at + 2 };
    keys.forEach((k, i) => {
      const raw = (line[i] ?? "").trim();
      if (!k || raw === "") return;
      if (MONEY.has(k)) {
        // "Rs 1,290.00" as well as "1290"
        const cents = money(raw.replace(/^rs\.?\s*/i, ""));
        if (cents === null) r.bad = r.bad ?? (k === "price" ? "price-missing" : "bad-number");
        else r[k] = cents;
      } else if (QTY.has(k)) {
        const v = Number(raw.replace(/\s/g, ""));
        if (!Number.isFinite(v) || v < 0) r.bad = r.bad ?? "bad-number";
        else r[k] = Math.round(v * 1000);
      } else r[k] = raw.slice(0, 120);
    });
    rows.push(r as CatalogRow);
  });
  return { rows, unknown, noName: !keys.includes("name") };
}
