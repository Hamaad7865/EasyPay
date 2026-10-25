// A day closing laid out as a report, from the parts of its paper as the till
// laid them out (EscPos.parts on the till: a row with its two sides, a line of
// text, a rule, each with whether it was bold and its size). The mail's HTML
// is made here; its PDF (pdf.js) is made from the same shape, so the two read
// alike. Every character a till sent is escaped where it is put in HTML.
import { esc } from "./esc.js";

const KINDS = new Set(["row", "text", "center", "rule"]);
const SIZES = new Set(["normal", "tall", "big"]);
export const PART_LIMITS = { parts: 400, left: 200, right: 100 };

const plain = (s, most) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, most);

// The parts as a till sent them ({k, l, r, b, s}), read and checked; null when
// there are none or they cannot be read, and the report is then made from the
// paper's lines.
export function readParts(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PART_LIMITS.parts) return null;
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== "object" || !KINDS.has(p.k)) return null;
    out.push({
      k: p.k,
      l: typeof p.l === "string" ? plain(p.l, PART_LIMITS.left) : "",
      r: typeof p.r === "string" ? plain(p.r, PART_LIMITS.right) : "",
      b: p.b === true,
      s: SIZES.has(p.s) ? p.s : "normal",
    });
  }
  return out;
}

// A paper's lines as parts, for a till that sent none: a line of dashes is a rule.
export const partsOfLines = (lines) => lines.map((l) => (/^-{8,}$/.test(l.trim()) ? { k: "rule", l: "", r: "", b: false, s: "normal" } : { k: "text", l: l.trim(), r: "", b: false, s: "normal" }));

// "BY PAYMENT METHOD" reads "By payment method" in a report: words in capitals
// on paper are only how a narrow roll shows a heading.
export function said(s) {
  if (!/[A-Z]{2}/.test(s) || /[a-z]/.test(s.replace(/\bNo\.?/g, ""))) return s;
  const low = s.toLowerCase().replace(/\(z\)/g, "(Z)").replace(/\bno\./g, "No.").replace(/\brs\b/g, "Rs");
  return low.charAt(0).toUpperCase() + low.slice(1);
}

const TEST = "TEST, NOT A RECEIPT";

// The report's shape: what heads it (the business's own lines), its title, the
// closing's details, its total, and its sections, each with a title and rows.
export function shape(parts) {
  const groups = [[]];
  let test = false;
  for (const p of parts) {
    if (p.k === "rule") { groups.push([]); continue; }
    if ((p.k === "center" || p.k === "text") && p.l === TEST) { test = true; continue; }
    groups[groups.length - 1].push(p);
  }
  // before the first rule: the business, as its receipt heads it (its name is the mail's own)
  const header = groups.length > 1 ? groups.shift().filter((p) => p.l && p.s !== "big").map((p) => p.l) : [];
  let title = "";
  let meta = [];
  if (groups.length > 1 || (groups[0] && groups[0].some((p) => p.k === "center"))) {
    const first = groups.shift();
    const t = first.findIndex((p) => p.k === "center" && p.l);
    if (t >= 0) title = said(first[t].l);
    // the till is in the report's heading already
    meta = first.filter((p, i) => i !== t && p.k === "row" && p.l !== "Till").map((p) => ({ l: p.l, r: p.r }));
  }
  let total = null;
  let signature = false;
  const sections = [];
  for (const g of groups) {
    const items = [];
    let head = "";
    g.forEach((p, i) => {
      if (p.k === "row") {
        // a heading in capitals on paper reads as words; a row's own label (a tax's name: VAT) stays as it is
        const row = { l: p.b ? said(p.l) : p.l, r: p.r, b: p.b, big: p.s !== "normal" };
        if (row.big && !total) total = row;
        items.push({ kind: "row", ...row });
      } else if (p.l) {
        if (/^Signature:/.test(p.l)) { signature = true; return; }
        if (i === 0 && p.b && p.k === "text") head = said(p.l);
        else items.push({ kind: "note", l: p.b ? said(p.l) : p.l, b: p.b });
      }
    });
    if (head || items.length) sections.push({ title: head, items });
  }
  return { test, header, title, meta, total, sections, signature };
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#1f2421";
const SOFT = "#6b706c";
const LINE = "#ebe7df";
const GREEN = "#1d5c46";

// The mail's HTML: tables and inline styles only, as mail programs want it.
export function reportHtml(r, { business, till, date }, stop, attached = false) {
  const cell = "padding:7px 0;border-bottom:1px solid " + LINE + ";font:14px/1.4 " + FONT + ";color:" + INK;
  const rows = (items) => items.map((it) => it.kind === "row"
    ? `<tr><td style="${cell};${it.b ? "font-weight:700" : ""}">${esc(it.l)}</td><td align="right" style="${cell};white-space:nowrap;font-variant-numeric:tabular-nums;${it.b ? "font-weight:700" : ""}${it.big ? ";font-size:16px" : ""}">${esc(it.r)}</td></tr>`
    : `<tr><td colspan="2" style="padding:8px 0;font:${it.b ? "700" : "400"} 13px/1.45 ${FONT};color:${it.b ? INK : SOFT}">${esc(it.l)}</td></tr>`).join("");
  const sections = r.sections.map((s) =>
    `<tr><td style="padding:22px 0 0">${s.title ? `<div style="font:700 11px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${SOFT};padding-bottom:6px">${esc(s.title)}</div>` : ""}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid ${LINE}">${rows(s.items)}</table></td></tr>`).join("");
  const meta = r.meta.map((m) => `<tr><td style="padding:2px 16px 2px 0;font:13px/1.45 ${FONT};color:${SOFT};white-space:nowrap">${esc(m.l)}</td><td style="padding:2px 0;font:13px/1.45 ${FONT};color:${INK}">${esc(m.r)}</td></tr>`).join("");
  const total = r.total
    ? `<tr><td style="padding:20px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4f0;border-radius:10px"><tr>` +
      `<td style="padding:16px 18px;font:600 14px/1.3 ${FONT};color:${GREEN}">${esc(r.total.l)}</td>` +
      `<td align="right" style="padding:16px 18px;font:700 26px/1.1 ${FONT};color:${GREEN};white-space:nowrap;font-variant-numeric:tabular-nums">${esc(r.total.r)}</td></tr></table></td></tr>`
    : "";
  const banner = r.test ? `<tr><td style="padding:0 0 16px"><div style="background:#fdeceb;color:#a3261d;font:700 12px/1 ${FONT};letter-spacing:.06em;padding:10px 12px;border-radius:8px;text-align:center">${esc(TEST)}</div></td></tr>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>` +
    `<body style="margin:0;padding:0;background:#f3f1ec"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ec"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:14px">` +
    `<tr><td style="padding:28px 28px 26px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${banner}` +
    `<tr><td style="font:700 21px/1.25 ${FONT};color:${INK}">${esc(business)}</td></tr>` +
    (r.header.length ? `<tr><td style="padding-top:4px;font:13px/1.5 ${FONT};color:${SOFT}">${r.header.map(esc).join(" · ")}</td></tr>` : "") +
    `<tr><td style="padding-top:22px;font:700 12px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${GREEN}">${esc(r.title || "Day closing")}</td></tr>` +
    `<tr><td style="padding-top:6px;font:15px/1.4 ${FONT};color:${INK}">${esc(till)}${date ? " · " + esc(date) : ""}</td></tr>` +
    (meta ? `<tr><td style="padding-top:12px"><table role="presentation" cellpadding="0" cellspacing="0">${meta}</table></td></tr>` : "") +
    total + sections +
    `</table></td></tr></table>` +
    `<p style="max-width:600px;margin:16px auto 0;font:12px/1.6 ${FONT};color:${SOFT};text-align:center">${attached ? "The same report is attached as a PDF. " : ""}Sent by EasyPay for ${esc(business)}, ${esc(till)}, at each day closing. <a href="${esc(stop)}" style="color:${GREEN}">Stop these emails</a></p>` +
    `</td></tr></table></body></html>`;
}
