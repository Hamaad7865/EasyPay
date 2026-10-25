// What the mail service takes and what it writes, apart from Cloudflare, so
// that it can be tested by itself (rules.test.mjs).
//
// A till never writes a mail. It sends what a day closing printed, as lines of
// text and as the parts its paper was laid out from, and the names it is known
// by; the mails, their subjects, the report (report.js) and the pages are made
// here, with every character the till sent escaped. Nothing here sends, keeps
// or counts anything: index.js does.
import { esc } from "./esc.js";
import { readParts, partsOfLines, shape, reportHtml } from "./report.js";
export { esc };

export const LIMITS = {
  bodyBytes: 64 * 1024, // a request's body
  lines: 400, // lines of a Z report
  lineChars: 200, // characters a line
  business: 80,
  till: 40,
  address: 254,
  // a confirm mail: at most one in askEveryMs for an address, so many a day for an
  // address, from one internet address, and in all
  askEveryMs: 10 * 60 * 1000,
  asksPerAddress: 3,
  asksPerIp: 10,
  asks: 200,
  // Z mails a day: for one address, and in all (the account's included mails are shared)
  zPerAddress: 20,
  z: 1000,
  askKeepMs: 7 * 86400000, // an ask nobody confirmed is forgotten after a week
  idKeepMs: 14 * 86400000, // a mail's id is remembered this long, so it goes once
};

// who EasyPay's mail is from
export const FROM = { email: "reports@easypaypos.com", name: "EasyPay" };

// Control characters out (a line's own spaces stay), and nothing longer than `most`.
const plain = (s, most) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, most);

// A name a till sends (the business, the till): one line, no link in it, within
// its length. A link is taken out: the confirm mail goes to an address nobody
// has confirmed yet, and must carry nothing anyone could use to advertise.
export function nameOf(raw, most) {
  if (typeof raw !== "string") return "";
  return plain(raw, 400).replace(/(?:https?:\/\/|www\.)\S*/gi, "").replace(/\s+/g, " ").trim().slice(0, most).trim();
}

// An address as it is kept and compared: trimmed and in small letters. Null
// when it is not one.
export function addressOf(raw) {
  if (typeof raw !== "string") return null;
  const a = raw.trim().toLowerCase();
  if (a.length > LIMITS.address) return null;
  const m = /^([^\s@<>()[\]\\,;:"']{1,64})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/.exec(a);
  if (!m || m[1].startsWith(".") || m[1].endsWith(".") || m[1].includes("..")) return null;
  if (!/\.[a-z]{2,63}$/.test(m[2])) return null;
  return a;
}

// The till's key: 64 hexadecimal characters it made itself, kept on the tablet.
export const isKey = (k) => typeof k === "string" && /^[0-9a-f]{64}$/.test(k);

// What a till asks, read and checked. Each answers { error } or what was asked.
export function readAsk(raw) {
  if (!raw || typeof raw !== "object") return { error: "not understood" };
  const to = addressOf(raw.to);
  if (!to) return { error: "that is not an email address" };
  if (!isKey(raw.key)) return { error: "the till's key is missing" };
  // a business that has no name yet (or one that was only a link) is EasyPay's to the reader
  return { to, key: raw.key, business: nameOf(raw.business, LIMITS.business) || "EasyPay", till: nameOf(raw.till, LIMITS.till) || "Till" };
}

export function readWho(raw) {
  if (!raw || typeof raw !== "object") return { error: "not understood" };
  const to = addressOf(raw.to);
  if (!to) return { error: "that is not an email address" };
  if (!isKey(raw.key)) return { error: "the till's key is missing" };
  return { to, key: raw.key };
}

export function readZ(raw) {
  const who = readWho(raw);
  if (who.error) return who;
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(raw.id)) return { error: "the closing's id is missing" };
  if (!Number.isInteger(raw.number) || raw.number < 1 || raw.number > 9999999) return { error: "the closing's number is missing" };
  // the day and time of the closing as the till writes it, "25/10/2026 23:10"
  const date = typeof raw.date === "string" && /^[0-9/:. -]{1,20}$/.test(raw.date) ? raw.date.trim() : "";
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) return { error: "the report is empty" };
  if (raw.lines.length > LIMITS.lines) return { error: "the report is too long" };
  if (raw.lines.some((l) => typeof l !== "string")) return { error: "the report could not be read" };
  const lines = raw.lines.map((l) => plain(l, LIMITS.lineChars).replace(/\s+$/, ""));
  return { ...who, id: raw.id, number: raw.number, date, lines, parts: readParts(raw.parts), business: nameOf(raw.business, LIMITS.business) || "EasyPay", till: nameOf(raw.till, LIMITS.till) || "Till", test: raw.test === true };
}

const FOOT_STYLE = "color:#6b6f76;font:13px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:18px 0 0";

// A report's shape, from the parts the till sent, or from its paper's lines.
export const zShape = (report) => shape(report.parts || partsOfLines(report.lines));

// The PDF's name: "Z-report-12-Till-1-2026-10-25.pdf".
export function zFile({ number, till, date }) {
  const day = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(date || "");
  const slug = String(till).normalize("NFD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "Till";
  return `Z-report-${number}-${slug}${day ? `-${day[3]}-${day[2]}-${day[1]}` : ""}.pdf`;
}

// A day closing's mail: the report, laid out (report.js); the paper's lines
// for a mail read as text; the same report as a PDF, when it could be made
// (its bytes); and how to stop them.
export function zMail(report, stop, pdf = null) {
  const { to, business, till, number, date, lines, test } = report;
  const subject = `${test ? "TEST · " : ""}Z report No. ${number} · ${business} · ${till}${date ? " · " + date : ""}`.slice(0, 250);
  const why = `Sent by EasyPay for ${business}, ${till}, at each day closing.`;
  const text = `${lines.join("\n")}\n\n--\n${pdf ? "The same report is attached as a PDF.\n" : ""}${why}\nStop these emails: ${stop}\n`;
  const html = reportHtml(zShape(report), { business, till, date }, stop, !!pdf);
  return {
    to, from: FROM, subject, text, html,
    ...(pdf ? { attachments: [{ content: pdf, filename: zFile(report), type: "application/pdf", disposition: "attachment" }] } : {}),
    // a mail client's own "unsubscribe" goes to the same page, one click (RFC 8058)
    headers: { "List-Unsubscribe": `<${stop}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

// The one mail an address gets before anyone has confirmed it.
export function askMail({ to, business, till }, confirm) {
  const ask = `${business}'s till, ${till}, asks to send its Z report (the day's closing figures) to this address at each day closing.`;
  const what = "If you set this up, press Confirm. If you did not, ignore this email: nothing more is sent.";
  const text = `${ask}\n\n${what}\n\nConfirm: ${confirm}\n\n--\nEasyPay, point of sale\n`;
  const html =
    `<!doctype html><html><body style="margin:0;padding:20px;background:#f6f4ef;font:15px/1.55 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d1f22">` +
    `<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3ded3;border-radius:10px;padding:24px">` +
    `<p style="margin:0 0 12px">${esc(ask)}</p><p style="margin:0 0 20px">${esc(what)}</p>` +
    `<p style="margin:0"><a href="${esc(confirm)}" style="display:inline-block;background:#1d5c46;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Confirm</a></p>` +
    `</div><p style="${FOOT_STYLE};text-align:center">EasyPay, point of sale</p></body></html>`;
  return { to, from: FROM, subject: `Confirm: Z reports of ${business} to this address`.slice(0, 250), text, html };
}

// A page of the service's own: a confirm or stop, with its button. A button,
// not the link itself, does it: a mail scanner opens every link in a mail.
export function page(title, words, button) {
  const form = button ? `<form method="post"><button type="submit">${esc(button)}</button></form>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(title)} · EasyPay</title><style>` +
    `body{margin:0;background:#f6f4ef;color:#1d1f22;font:16px/1.55 -apple-system,Segoe UI,Roboto,Arial,sans-serif}` +
    `main{max-width:480px;margin:12vh auto 0;padding:0 16px}div{background:#fff;border:1px solid #e3ded3;border-radius:12px;padding:24px}` +
    `h1{font-size:21px;margin:0 0 10px}p{margin:0 0 16px}button{font:inherit;font-weight:700;background:#1d5c46;color:#fff;border:0;border-radius:8px;padding:12px 22px;cursor:pointer}` +
    `small{display:block;text-align:center;color:#6b6f76;margin-top:16px}` +
    `@media (prefers-color-scheme:dark){body{background:#151716;color:#ecebe6}div{background:#1f2321;border-color:#333833}small{color:#9a9e99}}` +
    `</style></head><body><main><div><h1>${esc(title)}</h1>${words.map((w) => `<p>${esc(w)}</p>`).join("")}${form}</div><small>EasyPay, point of sale</small></main></body></html>`;
}

// The UTC day a count is of: counts start again each day.
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// What Cloudflare's refusal of a mail means: never for this address
// ("refused"), or try again later ("later"). Not onboarded, a limit, a fault of
// theirs: later, once it is put right.
export function refusal(code) {
  if (code === "E_RECIPIENT_SUPPRESSED") return { kind: "refused", words: "this address bounced EasyPay's mail or marked it as spam" };
  if (code === "E_VALIDATION_ERROR" || code === "E_FIELD_MISSING") return { kind: "refused", words: "EasyPay's mail could not be sent to this address" };
  return { kind: "later", words: "EasyPay's mail could not be sent just now" };
}
