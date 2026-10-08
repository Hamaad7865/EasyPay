// A catalog file's cells as the rows the database takes (catalog_import,
// migration 0071): money in cents, quantities in thousandths. Pure, with no
// imports, so the import screen uses it in the browser and its test runs it
// under node; the money reader is handed in (lib/money's parseRs).
//
// A file's columns are matched to what the import knows by their headers
// (autoMap), and the person importing can say otherwise for any of them: a
// supplier's own sheet goes in without its headers being retyped.

// One line of the file. `n` is the row's number in the file (the first row
// is 1); `bad` is a problem found here, which the database then reports
// without looking further at the row.
export type CatalogRow = {
  n: number;
  name?: string; category?: string; brand?: string; supplier?: string; supplier_code?: string;
  o1?: string; v1?: string; o2?: string; v2?: string; o3?: string; v3?: string;
  sku?: string; barcode?: string; tax?: string;
  price?: number | null; cost?: number | null; reorder?: number | null; order_qty?: number | null; stock?: number | null;
  bad?: string;
};

// What a column of the file can be: one of the row's own fields, or "option",
// a variant option that takes its name from the column's header (a column
// headed Size whose cells say M and L). Up to three columns can be options.
export type Target = Exclude<keyof CatalogRow, "n" | "bad"> | "option";
export type Mapping = (Target | null)[];

// `words` are the headers a column of that kind usually carries, as letters
// and digits only, lower case, without accents. The template spells each the
// first way. `pair` marks the columns of EasyPay's own file, where an option's
// name and its value are two columns: they are offered last.
export const FIELDS: { key: Target; label: string; required?: boolean; pair?: boolean; words: string[] }[] = [
  { key: "name", label: "Product name", required: true, words: ["name", "product", "productname", "item", "itemname", "description", "designation", "nom", "produit", "article", "libelle"] },
  { key: "price", label: "Selling price", required: true, words: ["price", "sellingprice", "sellprice", "retailprice", "retail", "rrp", "unitprice", "prix", "prixdevente", "prixvente", "pv"] },
  { key: "category", label: "Category", words: ["category", "cat", "department", "group", "categorie", "famille", "rayon"] },
  { key: "brand", label: "Brand", words: ["brand", "make", "marque"] },
  { key: "supplier", label: "Supplier", words: ["supplier", "vendor", "suppliername", "fournisseur"] },
  { key: "supplier_code", label: "Supplier's code", words: ["suppliercode", "supplierscode", "supplierref", "vendorcode", "reffournisseur", "codefournisseur"] },
  { key: "sku", label: "SKU (your own code)", words: ["sku", "code", "productcode", "itemcode", "stockcode", "ref", "reference"] },
  { key: "barcode", label: "Barcode", words: ["barcode", "ean", "ean13", "upc", "gtin", "codebarre", "codebarres", "codeabarres"] },
  { key: "cost", label: "Cost", words: ["cost", "costprice", "buyprice", "buyingprice", "purchaseprice", "unitcost", "cout", "prixdachat", "prixachat", "pa"] },
  { key: "tax", label: "Tax", words: ["tax", "vat", "taxname", "tva", "taxe"] },
  { key: "stock", label: "Opening stock", words: ["openingstock", "stock", "quantity", "qty", "instock", "onhand", "units", "pcs", "quantite", "qte"] },
  { key: "reorder", label: "Reorder at", words: ["reorderat", "reorderlevel", "reorder", "reorderpoint", "minimum", "minstock", "seuil"] },
  { key: "order_qty", label: "Order quantity", words: ["orderquantity", "orderqty", "reorderquantity", "reorderqty"] },
  { key: "option", label: "A variant option, named after this column", words: ["size", "sizes", "colour", "color", "taille", "couleur", "pointure"] },
  { key: "o1", label: "Option 1: its name", pair: true, words: ["option1", "option1name"] },
  { key: "v1", label: "Option 1: its value", pair: true, words: ["value1", "option1value"] },
  { key: "o2", label: "Option 2: its name", pair: true, words: ["option2", "option2name"] },
  { key: "v2", label: "Option 2: its value", pair: true, words: ["value2", "option2value"] },
  { key: "o3", label: "Option 3: its name", pair: true, words: ["option3", "option3name"] },
  { key: "v3", label: "Option 3: its value", pair: true, words: ["value3", "option3value"] },
];
export const REQUIRED: Target[] = FIELDS.filter((f) => f.required).map((f) => f.key);
// how many columns may be options named after themselves
export const MOST_OPTIONS = 3;

const MONEY = new Set<Target>(["price", "cost"]);
const QTY = new Set<Target>(["reorder", "order_qty", "stock"]);

// a header as it is compared: its letters and digits, lower case, without accents
export const headerKey = (h: string) => h.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const empty = (line: string[] | undefined) => !line || line.every((c) => String(c ?? "").trim() === "");

// The row the headers are on: the first that is not empty.
export function headerRow(cells: string[][]): number {
  const at = cells.findIndex((line) => !empty(line));
  return at < 0 ? 0 : at;
}

// What each column is taken for, from its header alone. A kind of column is
// given to the first header that answers to it, and to no second one (two
// columns headed Price are not both the price); an option, to the first three.
export function autoMap(header: string[]): Mapping {
  const used = new Set<Target>();
  let options = 0;
  return header.map((h) => {
    const key = headerKey(h ?? "");
    if (key === "") return null;
    const f = FIELDS.find((x) => x.words.includes(key));
    if (!f) return null;
    if (f.key === "option") {
      if (options >= MOST_OPTIONS) return null;
      options += 1;
      return "option";
    }
    if (used.has(f.key)) return null;
    used.add(f.key);
    return f.key;
  });
}

// What stops a mapping from being used, in words, or null when it can be.
export function mappingProblem(mapping: Mapping): string | null {
  const missing = FIELDS.filter((f) => f.required && !mapping.includes(f.key)).map((f) => f.label.toLowerCase());
  if (missing.length) return `Say which column holds the ${missing.join(" and the ")}.`;
  const seen = new Set<Target>();
  for (const m of mapping) {
    if (!m || m === "option") continue;
    if (seen.has(m)) return `Two columns are set to ${FIELDS.find((f) => f.key === m)?.label.toLowerCase()}. Keep one.`;
    seen.add(m);
  }
  if (mapping.filter((m) => m === "option").length > MOST_OPTIONS) return "A product has three options at most. Set fewer columns as options.";
  return null;
}

// `cells` is the file as parseCsv or readXlsx gives it. The headers are on its
// first row that is not empty; a row with nothing in it is skipped. `mapping`
// says what each column is (autoMap's guess when it is not given). `unknown`
// are the headers of the columns that are not read; `noName` says no column
// is the product's name, so the file is not a catalog as it stands.
export function toCatalogRows(
  cells: string[][], money: (s: string) => number | null, mapping?: Mapping,
): { rows: CatalogRow[]; unknown: string[]; noName: boolean; header: string[]; mapping: Mapping } {
  const at = headerRow(cells);
  const header = (cells[at] ?? []).map((h) => String(h ?? "").trim());
  const keys = mapping ?? autoMap(header);
  const unknown = header.filter((h, i) => !keys[i] && h !== "");
  const rows: CatalogRow[] = [];
  cells.slice(at + 1).forEach((line, i) => {
    if (empty(line)) return;
    const r: Record<string, unknown> = { n: at + i + 2 };
    const named: [string, string][] = [];
    keys.forEach((k, col) => {
      const raw = String(line[col] ?? "").trim();
      if (!k || raw === "") return;
      if (k === "option") named.push([header[col].slice(0, 30), raw.slice(0, 120)]);
      else if (MONEY.has(k)) {
        // "Rs 1,290.00" as well as "1290"
        const cents = money(raw.replace(/^rs\.?\s*/i, ""));
        if (cents === null) r.bad = r.bad ?? (k === "price" ? "price-missing" : "bad-number");
        else r[k] = cents;
      } else if (QTY.has(k)) {
        // "1,200" is twelve hundred; "2,5" is not a number here (it would be read as 25 or as 2.5, and which is a guess)
        const tidy = raw.replace(/\s/g, "");
        const v = Number(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(tidy) ? tidy.replace(/,/g, "") : tidy);
        if (!Number.isFinite(v) || v < 0) r.bad = r.bad ?? "bad-number";
        else r[k] = Math.round(v * 1000);
      } else r[k] = raw.slice(0, 120);
    });
    // options named after their columns take the places the file's own Option columns left free, in the order of the columns
    for (const [name, value] of named) {
      const slot = ([1, 2, 3] as const).find((s) => r["o" + s] === undefined && r["v" + s] === undefined);
      if (!slot) { r.bad = r.bad ?? "bad-options"; break; }
      r["o" + slot] = name;
      r["v" + slot] = value;
    }
    rows.push(r as CatalogRow);
  });
  return { rows, unknown, noName: !keys.includes("name"), header, mapping: keys };
}
