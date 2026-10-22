import { requirePerm } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { onMra } from "@/lib/mra";
import { csvLine, INVOICES_SQL, invoiceParams, MRA_TYPES, type MraInvoiceRow, mraFilters, reasons, signedCents, statusWords } from "@/lib/mra-page";

// The invoices the MRA page shows, all of them, as a spreadsheet: the same
// question with the same filters, without the QR pictures.

export const dynamic = "force-dynamic";

const MOST = 50000;

export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await requirePerm("reports.view");
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // a redirect to the sign-in page
    return new Response("You are not allowed to download the invoices sent to the MRA.", { status: 403 });
  }
  if (!onMra(ctx.mra)) return new Response("Not found", { status: 404 });
  const asked = new URL(req.url).searchParams;
  const f = mraFilters((k) => asked.get(k) ?? "");
  const rows = await readTenant(ctx.tenantId, async (c) => (await c.query(INVOICES_SQL, invoiceParams(ctx.tenantId, f, MOST, false))).rows as MraInvoiceRow[]);
  const lines = [csvLine(["Issued", "Branch", "Till", "Number", "Type", "For", "Amount", "Status", "IRN", "The MRA said", "Warnings"])];
  for (const r of rows) {
    // the branch's own clock, written so a spreadsheet reads it as a date and time
    const when = new Intl.DateTimeFormat("sv-SE", { timeZone: r.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const cents = signedCents(r.type, r.paid);
    lines.push(
      csvLine([
        when.format(new Date(r.at)), r.store, r.till, r.identifier, MRA_TYPES[r.type as keyof typeof MRA_TYPES] ?? r.type, r.ref,
        cents === null ? "" : (cents / 100).toFixed(2), statusWords(r.status), r.irn, reasons(r.errors), reasons(r.warnings),
      ]),
    );
  }
  // the mark at the start tells a spreadsheet the file is UTF-8, so accents survive
  return new Response("﻿" + lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="mra-invoices.csv"`,
      "cache-control": "no-store",
    },
  });
}
