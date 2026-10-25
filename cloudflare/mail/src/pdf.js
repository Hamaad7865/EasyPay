// A day closing as a PDF, A4, from the report's shape (report.js): what the
// mail's HTML shows, for printing and keeping. Made with pdf-lib and its own
// Helvetica, so nothing is loaded and nothing is fetched. Helvetica has the
// Western European characters only (WinAnsi): any other is written without
// its accent, or as "?".
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const A4 = [595.28, 841.89];
const M = 40; // margin
const INK = rgb(0.12, 0.14, 0.13);
const SOFT = rgb(0.42, 0.44, 0.42);
const LINE = rgb(0.9, 0.89, 0.86);
const GREEN = rgb(0.11, 0.36, 0.27);
const TINT = rgb(0.93, 0.96, 0.94);
const RED = rgb(0.64, 0.15, 0.11);

// What Helvetica can write: printable ASCII and Latin-1, and the few others WinAnsi has.
const WIN = new Set([..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"]);
export function winAnsi(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN.has(ch)) out += ch;
    else if (c < 0x20) out += " ";
    else {
      const bare = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      out += bare && [...bare].every((b) => b.codePointAt(0) <= 0xff) ? bare : "?";
    }
  }
  return out;
}

export async function reportPdf(r, { business, till, date }) {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(`${r.title || "Day closing"} · ${business} · ${till}`));
  doc.setAuthor("EasyPay");
  doc.setCreator("EasyPay");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const right = A4[0] - M;
  let page;
  let y;
  const newPage = () => { page = doc.addPage(A4); y = A4[1] - M; };
  const room = (h) => { if (y - h < M + 24) newPage(); };
  const text = (s, x, size, font = regular, color = INK) => page.drawText(winAnsi(s), { x, y, size, font, color });
  const textRight = (s, size, font = regular, color = INK) => { const t = winAnsi(s); page.drawText(t, { x: right - font.widthOfTextAtSize(t, size), y, size, font, color }); };
  const fit = (s, size, font, width) => { let t = winAnsi(s); while (t.length > 1 && font.widthOfTextAtSize(t, size) > width) t = t.slice(0, -2) + "…"; return t; };
  const rule = (color = LINE) => page.drawLine({ start: { x: M, y }, end: { x: right, y }, thickness: 0.6, color });

  newPage();
  if (r.test) {
    page.drawRectangle({ x: M, y: y - 20, width: right - M, height: 24, color: rgb(0.99, 0.93, 0.92) });
    y -= 13; text("TEST, NOT A RECEIPT", M + 10, 10, bold, RED); y -= 25;
  }
  y -= 14; text(fit(business, 17, bold, right - M), M, 17, bold); y -= 15;
  // the business's own lines, as its receipts head them, on one or two lines
  const head = r.header.join("  ·  ");
  if (head) { text(fit(head, 9, regular, right - M), M, 9, regular, SOFT); y -= 11.5; }
  y -= 14; text((r.title || "Day closing").toUpperCase(), M, 9, bold, GREEN); y -= 15;
  text(fit(`${till}${date ? " · " + date : ""}`, 12, regular, right - M), M, 12); y -= 16;
  // the closing's details in two columns
  const half = (right - M) / 2;
  r.meta.forEach((m, i) => {
    const x = M + (i % 2) * half;
    text(fit(m.l, 9, regular, 70), x, 9, regular, SOFT);
    text(fit(m.r, 9, regular, half - 80), x + 72, 9);
    if (i % 2 === 1 || i === r.meta.length - 1) y -= 12.5;
  });

  if (r.total) {
    y -= 8; room(40);
    page.drawRectangle({ x: M, y: y - 34, width: right - M, height: 38, color: TINT });
    y -= 22; text(r.total.l, M + 12, 10.5, bold, GREEN);
    const t = winAnsi(r.total.r);
    page.drawText(t, { x: right - 12 - bold.widthOfTextAtSize(t, 16), y: y - 1, size: 16, font: bold, color: GREEN });
    y -= 16;
  }

  for (const s of r.sections) {
    y -= 13; room(34);
    if (s.title) { text(s.title.toUpperCase(), M, 8, bold, SOFT); y -= 6; }
    rule(); y -= 11.5;
    for (const it of s.items) {
      room(16);
      if (it.kind === "row") {
        const size = it.big ? 10.5 : 9.5;
        const font = it.b ? bold : regular;
        text(fit(it.l, size, font, right - M - 130), M, size, font);
        textRight(it.r, size, font);
      } else {
        text(fit(it.l, 9, it.b ? bold : regular, right - M), M, 9, it.b ? bold : regular, it.b ? INK : SOFT);
      }
      y -= 4.5; rule(); y -= 10;
    }
  }

  if (r.signature) {
    y -= 26; room(36);
    text("Signature", M, 9.5, regular, SOFT);
    page.drawLine({ start: { x: M + 60, y: y - 2 }, end: { x: M + 300, y: y - 2 }, thickness: 0.6, color: SOFT });
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const foot = winAnsi(`EasyPay · ${business} · ${till} · ${r.title || "Day closing"}${pages.length > 1 ? ` · page ${i + 1} of ${pages.length}` : ""}`);
    p.drawText(fit(foot, 8, regular, right - M), { x: M, y: M - 14, size: 8, font: regular, color: SOFT });
  });
  return doc.save();
}

// Bytes as base64, as the mail binding takes an attachment.
export function base64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
