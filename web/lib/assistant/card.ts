// The assistant's cards as HTML (spec, The card): what Claude shows as an MCP
// App, and what the back office's confirm page shows the same. The tablet part
// (the tile, the sheet that asks which one) is drawn like the till, with the
// till's colours (android core/ui/V2.kt) and its shapes (RetailSell.kt: Tile,
// VariantSheet), on a panel of the till's own ground; the rest sits quietly
// in either theme. No scripts: the app's shim gives the card its behaviour by
// its data attributes (data-history, data-confirm, data-cancel,
// data-type-name). Pure, with no imports but types, so its test runs it under
// node: `node web/lib/assistant/card.test.mjs`.

import type { Card, DoneCard, Grid, HistoryCard, LinesCard, PreviewCard, ProductCard, Reading, Sheet, SheetKey, StockMove, Tile, Tone, Warning } from "./types";

// Every text on a card comes from the shop's rows: a product's name can hold
// <, & or quotes, so each one is escaped, in text and in attributes alike.
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

// A link or a picture only as a web address or a page of the back office;
// anything else (javascript:, a stray word) is left out.
function safeUrl(u: string | null | undefined, picture = false): string | null {
  const s = String(u ?? "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  if (picture && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(s)) return s;
  return null;
}

// What stands for a product with no picture, as on the till (PictureCard.kt):
// the first letter of its first two words, or the first two of its only one.
function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1) {
    const w = Array.from(words[0]).slice(0, 2).join("");
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

const TONES: Tone[] = ["plenty", "few", "none", "below"];
function tone(t: Tone | null | undefined): string {
  return t && TONES.includes(t) ? t : "nil";
}

const CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>`;

function section(label: string, body: string): string {
  return `<section class="ep-sec"><h3 class="ep-label">${esc(label)}</h3>${body}</section>`;
}

// A list in words: the first eight shown, the rest folded underneath.
function said(lines: string[]): string {
  if (!lines.length) return "";
  const li = (s: string) => `<li>${esc(s)}</li>`;
  const rest = lines.slice(8);
  return (
    `<ul class="ep-bullets">${lines.slice(0, 8).map(li).join("")}</ul>` +
    (rest.length ? `<details class="ep-fold"><summary>${String(rest.length)} more</summary><ul class="ep-bullets">${rest.map(li).join("")}</ul></details>` : "")
  );
}

// ---------------------------------------------------------------- the tablet

// The product's tile on the Sell screen: its picture along the top, then its
// name, its price, and how many variants with what is left of them.
function tileHtml(t: Tile): string {
  const pic = safeUrl(t.picture, true);
  const band = pic ? `<img src="${esc(pic)}" alt="" loading="lazy">` : `<span class="ep-initials">${esc(initials(t.name))}</span>`;
  const note = [t.lines > 1 ? `${String(t.lines)} variants` : "", t.pieces ?? ""].filter(Boolean).join(", ");
  return (
    `<div class="ep-tile"><div class="ep-band">${band}</div><div class="ep-tile-body">` +
    (t.category ? `<div class="ep-tile-cat">${esc(t.category)}</div>` : "") +
    `<div class="ep-tile-name">${esc(t.name)}</div>` +
    `<div class="ep-tile-foot"><span class="ep-tile-price">${esc(t.price)}</span>${note ? `<span class="ep-tile-note">${esc(note)}</span>` : ""}</div>` +
    `</div></div>`
  );
}

// One key of the sheet: the value, lit in the On colours when it is the line
// the change makes or touches, and on the last option what is left of it.
function keyHtml(k: SheetKey, last: boolean): string {
  const cls = ["ep-key", k.on ? "ep-on" : "", k.isNew ? "ep-key-new" : ""].filter(Boolean).join(" ");
  const left = last && k.left != null ? `<span class="ep-left ep-l-${tone(k.tone)}">${esc(k.left)}</span>` : "";
  return `<span class="${cls}">${k.isNew ? `<span class="ep-key-tag">New</span>` : ""}<span class="ep-key-v">${esc(k.value)}</span>${left}</span>`;
}

// The sheet that asks which one (VariantSheet): the picture and the name and
// the price on top, per option its label and its keys, the Add key below.
function sheetHtml(s: Sheet, t: Tile | null): string {
  const pic = t ? safeUrl(t.picture, true) : null;
  const head = t
    ? `<div class="ep-sheet-head">${pic ? `<img class="ep-square" src="${esc(pic)}" alt="" loading="lazy">` : ""}<div class="ep-sheet-name">${esc(t.name)}</div><div class="ep-sheet-price">${esc(t.price)}</div></div>`
    : "";
  const lastAt = s.options.length - 1;
  const options = s.options
    .map((o, i) => {
      const last = i === lastAt;
      const counted = last && o.keys.some((k) => k.left != null);
      const keys = o.keys.map((k) => keyHtml(k, last)).join("") + (o.more > 0 ? `<span class="ep-key ep-key-more">+${String(o.more)}</span>` : "");
      return `<div class="ep-opt"><div class="ep-opt-name">${esc(o.name)}</div><div class="ep-keys${counted ? " ep-keys-left" : ""}">${keys}</div></div>`;
    })
    .join("");
  return `<div class="ep-sheet">${head}${options}${s.add ? `<div class="ep-add">${esc(s.add)}</div>` : ""}</div>`;
}

function tabletHtml(t: Tile | null, s: Sheet | null): string {
  // a tile alone is a tile on the screen, not a screen-wide band
  return `<div class="ep-tablet${s ? "" : " ep-tablet-solo"}">${t ? `<div class="ep-tablet-tile">${tileHtml(t)}</div>` : ""}${s ? sheetHtml(s, t) : ""}</div>`;
}

// ---------------------------------------------------------------- the kinds

// A product's stock as a grid (Q28): the first option down, the second across;
// each number is a key that opens that line's history.
function gridHtml(g: Grid): string {
  const head = `<tr><th class="ep-corner"></th>${g.cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr>`;
  const body = g.rows
    .map((r, i) => {
      const cells = g.cols
        .map((c, j) => {
          const cell = g.cells[i]?.[j] ?? null;
          if (!cell) return `<td class="ep-nil" aria-label="No line">&middot;</td>`;
          return `<td><button type="button" class="ep-q ep-q-${tone(cell.tone)}" data-history="${esc(cell.line)}" aria-label="${esc(`${r}, ${c}: ${cell.qty}`)}" title="Open its history">${esc(cell.qty)}</button></td>`;
        })
        .join("");
      return `<tr><th scope="row">${esc(r)}</th>${cells}</tr>`;
    })
    .join("");
  return `<div class="ep-grid">${g.title ? `<div class="ep-grid-title">${esc(g.title)}</div>` : ""}<div class="ep-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;
}

function chipsHtml(values: { value: string; lines: number }[]): string {
  const chip = (v: { value: string; lines: number }) =>
    `<span class="ep-chip" title="${esc(`${v.lines} lines`)}">${esc(v.value)}<span class="ep-chip-n">${String(v.lines)}</span></span>`;
  const rest = values.slice(16);
  return (
    `<div class="ep-chips">${values.slice(0, 16).map(chip).join("")}</div>` +
    (rest.length ? `<details class="ep-fold"><summary>${String(rest.length)} more</summary><div class="ep-chips">${rest.map(chip).join("")}</div></details>` : "")
  );
}

function productHtml(c: ProductCard): string {
  const options = c.options.length
    ? section(
        "Options",
        c.options
          .map((o) => `<div class="ep-optrow"><div class="ep-optrow-name">${esc(o.name)} <span class="ep-count">${String(o.values.length)}</span></div>${chipsHtml(o.values)}</div>`)
          .join(""),
      )
    : "";
  const head =
    `<div class="ep-head">${c.path ? `<div class="ep-eyebrow">${esc(c.path)}</div>` : ""}<h2 class="ep-title">${esc(c.tile.name)}</h2></div>` +
    `<div class="ep-prod"><div class="ep-tablet"><div class="ep-tablet-tile">${tileHtml(c.tile)}</div></div><div class="ep-prod-info">${options}</div></div>`;
  const across = c.options.length >= 2 ? `<p class="ep-hint">${esc(`${c.options[0].name} down, ${c.options[1].name} across. Press a number for its history.`)}</p>` : "";
  const grids = c.grids.length ? section(`Stock at ${c.branch}`, across + c.grids.map(gridHtml).join("")) : "";
  const plain = c.plain.length
    ? section(
        c.grids.length ? "Other lines" : `Stock at ${c.branch}`,
        `<ul class="ep-rows">${c.plain.map((p) => `<li><span class="ep-row-main">${esc(p.line)}</span><span class="ep-qty ep-q-${tone(p.tone)}">${esc(p.qty)}</span></li>`).join("")}</ul>`,
      )
    : "";
  return head + grids + plain;
}

function linesHtml(c: LinesCard): string {
  const rows = c.rows
    .map(
      (r) =>
        `<tr><td><div class="ep-strong">${esc(r.product)}</div><div class="ep-sub">${esc(r.line)}</div></td><td class="ep-sub">${esc(r.branch)}</td><td class="ep-num ep-q-${tone(r.tone)}">${esc(r.qty)}</td></tr>`,
    )
    .join("");
  return (
    `<div class="ep-head"><h2 class="ep-title">${esc(c.title)}</h2></div>` +
    `<table class="ep-table"><thead><tr><th>Product and line</th><th>Branch</th><th class="ep-num">Qty</th></tr></thead><tbody>${rows}</tbody></table>` +
    (c.more > 0 ? `<p class="ep-more">${String(c.more)} more</p>` : "")
  );
}

function historyHtml(c: HistoryCard): string {
  const head = `<div class="ep-hist-head"><div class="ep-head"><h2 class="ep-title">${esc(c.product)}</h2><div class="ep-sub">${esc(c.line)}</div></div><div class="ep-now">now <b>${esc(c.now)}</b></div></div>`;
  const rows = c.rows
    .map((r) => {
      const q = String(r.qty ?? "").trim();
      const dir = /^[-−]/.test(q) ? " ep-down" : /^\+/.test(q) ? " ep-up" : "";
      const meta = [r.branch, r.who, r.ref].filter(Boolean).map(esc).join(" &middot; ");
      return `<li><span class="ep-when">${esc(r.when)}</span><span class="ep-row-main"><span class="ep-strong">${esc(r.what)}</span>${meta ? `<span class="ep-sub">${meta}</span>` : ""}</span><span class="ep-qty${dir}">${esc(r.qty)}</span></li>`;
    })
    .join("");
  return (
    head +
    (rows ? `<ul class="ep-rows ep-moves">${rows}</ul>` : `<p class="ep-more">No moves yet.</p>`) +
    (c.more ? `<p class="ep-more">Older moves: ask for more</p>` : "")
  );
}

function readingHtml(r: Reading): string {
  return (
    `<div class="ep-read"><div class="ep-said">&ldquo;${esc(r.said)}&rdquo;</div><div class="ep-arrow" aria-hidden="true">&rarr;</div>` +
    `<div class="ep-is"><span class="ep-strong">${esc(r.is)}</span>${r.isNew ? ` <span class="ep-new">New</span>` : ""}${r.note ? `<div class="ep-note">${esc(r.note)}</div>` : ""}</div></div>`
  );
}

function moveHtml(m: StockMove): string {
  const below = /^[-−]/.test(String(m.after ?? "").trim());
  return (
    `<li><span class="ep-row-main"><span class="ep-strong">${esc(m.line)}</span><span class="ep-sub">${esc(m.branch)}</span></span>` +
    `<span class="ep-change"><span class="ep-before">${esc(m.before)}</span><span class="ep-arrow" aria-label="becomes">&rarr;</span><span class="ep-after${below ? " ep-q-below" : ""}">${esc(m.after)}</span></span></li>`
  );
}

function warningHtml(w: Warning): string {
  const red = w.tone === "red" ? "red" : "amber";
  return `<div class="ep-warn ep-warn-${red}" role="note"><span class="ep-warn-mark" aria-hidden="true">!</span><span>${esc(w.text)}</span></div>`;
}

function previewHtml(c: PreviewCard): string {
  const link = safeUrl(c.link);
  return (
    `<div class="ep-head"><div class="ep-eyebrow">${esc(c.business)}</div><h2 class="ep-title">${esc(c.title)}</h2></div>` +
    (c.readings.length ? section("I read this as", `<div class="ep-reads">${c.readings.map(readingHtml).join("")}</div>`) : "") +
    (c.tile || c.sheet ? section("On the tablet", tabletHtml(c.tile, c.sheet)) : "") +
    (c.stock.length ? section("Stock", `<ul class="ep-rows">${c.stock.map(moveHtml).join("")}</ul>`) : "") +
    (c.lines.length ? section("What changes", said(c.lines)) : "") +
    (c.warnings.length ? `<div class="ep-warns">${c.warnings.map(warningHtml).join("")}</div>` : "") +
    (c.typeName
      ? `<input class="ep-typename" type="text" data-type-name="${esc(c.typeName)}" placeholder="${esc(`Type ${c.typeName} to confirm`)}" aria-label="${esc(`Type ${c.typeName} to confirm`)}" autocomplete="off" autocapitalize="off" spellcheck="false">`
      : "") +
    `<div class="ep-actions"><button type="button" class="ep-btn ep-cancel" data-cancel>Cancel</button>` +
    `<button type="button" class="ep-btn ep-confirm${c.danger ? " ep-confirm-red" : ""}" data-confirm="${esc(c.proposal)}">${esc(c.confirm)}</button></div>` +
    `<p class="ep-foot">Waits for you until ${esc(c.expires)}. Or confirm in the back office: ` +
    (link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link.replace(/^https?:\/\//i, ""))}</a>` : esc(c.link)) +
    `</p>`
  );
}

function doneHtml(c: DoneCard): string {
  return (
    `<div class="ep-done-head"><span class="ep-check">${CHECK}</span><h2 class="ep-title">${esc(c.title)}</h2></div>` +
    said(c.lines) +
    (c.tile || c.sheet ? section("On the tablet now", tabletHtml(c.tile, c.sheet)) : "")
  );
}

// The card's inner HTML, for a page that has CARD_CSS.
export function cardHtml(card: Card): string {
  let body = "";
  switch (card.kind) {
    case "product": body = productHtml(card); break;
    case "lines": body = linesHtml(card); break;
    case "history": body = historyHtml(card); break;
    case "preview": body = previewHtml(card); break;
    case "done": body = doneHtml(card); break;
  }
  const danger = card.kind === "preview" && card.danger ? " ep-danger" : "";
  return `<div class="ep ep-${esc(card.kind)}${danger}" data-kind="${esc(card.kind)}">${body}</div>`;
}

// ---------------------------------------------------------------- the look

// Each token with its light and its dark value. The quiet part takes the back
// office's paper and ink; t-* are the till's own (V2.kt: Bg, Panel, Key, On,
// OnText, OnSub, Text, Text2, Text3, Stroke); amber and red are AmberText and
// RedText; green and green-ink the Add key.
const TOKENS: [string, string, string][] = [
  ["surface", "#FFFFFF", "#1C1E22"],
  ["wash", "#F7F5EF", "#23262C"],
  ["line", "#E9E5DA", "#2E323A"],
  ["line2", "#D8D3C6", "#3A404B"],
  ["ink", "#16231C", "#F2F4F7"],
  ["ink2", "#49554D", "#A6AEBB"],
  ["ink3", "#6E7871", "#868E9C"],
  ["btn", "#F0EDE5", "#2A2E36"],
  ["btn-hover", "#E6E2D7", "#343944"],
  ["focus", "#15803D40", "#2BD48A50"],
  ["amber", "#9A6200", "#FFC15A"],
  ["amber-deep", "#744A00", "#FFD38A"],
  ["amber-wash", "#FCEFD2", "#3A2A0B"],
  ["amber-line", "#F1DFA0", "#5A4313"],
  ["amber-solid", "#F5A524", "#F5A524"],
  ["amber-ink", "#2B1A00", "#2B1A00"],
  ["red", "#C0272D", "#FF8A8E"],
  ["red-wash", "#FBE0E1", "#3A1C1E"],
  ["red-line", "#F5C6C1", "#5C2B2E"],
  ["red-solid", "#D93A40", "#D93A40"],
  ["red-hover", "#C3313A", "#E5484E"],
  ["green", "#2BD48A", "#2BD48A"],
  ["green-hover", "#22C07C", "#3DE29A"],
  ["green-ink", "#052A1B", "#052A1B"],
  ["green-text", "#0F8050", "#2BD48A"],
  ["t-bg", "#EEF0F4", "#131519"],
  ["t-panel", "#FFFFFF", "#1B1E24"],
  ["t-key", "#E4E7ED", "#252932"],
  ["t-on", "#1A1C21", "#F2F4F7"],
  ["t-ontext", "#FFFFFF", "#0D0F13"],
  ["t-onsub", "#B9C0CC", "#5B6577"],
  ["t-text", "#1A1C21", "#F2F4F7"],
  ["t-text2", "#4B5261", "#A6AEBB"],
  ["t-text3", "#7A8191", "#79818F"],
  ["t-stroke", "#D9DCE4", "#2B3039"],
  ["t-stroke2", "#C4C9D4", "#3A404B"],
];
const LIGHT = TOKENS.map(([n, l]) => `--ep-${n}:${l}`).join(";");
const DARK = TOKENS.map(([n, , d]) => `--ep-${n}:${d}`).join(";");

export const CARD_CSS: string = `
.ep{${LIGHT};color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .ep{${DARK};color-scheme:dark}}
[data-theme="dark"] .ep,.ep[data-theme="dark"]{${DARK};color-scheme:dark}
.ep{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;max-width:100%;min-width:0;padding:clamp(12px,4%,18px);border:1px solid var(--ep-line);border-radius:16px;background:var(--ep-surface);color:var(--ep-ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.45;text-align:left;overflow-wrap:break-word;-webkit-font-smoothing:antialiased}
.ep *,.ep *::before,.ep *::after{box-sizing:border-box}
.ep h2,.ep h3,.ep p,.ep ul,.ep li{margin:0;padding:0}
.ep ul{list-style:none}
.ep button,.ep input{font:inherit;color:inherit;margin:0}
.ep button{-webkit-tap-highlight-color:transparent}
.ep button:focus-visible,.ep summary:focus-visible,.ep a:focus-visible{outline:2px solid var(--ep-ink2);outline-offset:2px}
.ep.ep-danger{border-color:var(--ep-red-line);box-shadow:inset 0 4px 0 var(--ep-red-solid);padding-top:calc(clamp(12px,4%,18px) + 4px)}
.ep .ep-sec{min-width:0}
.ep .ep-head{display:flex;flex-direction:column;gap:2px;min-width:0}
.ep .ep-eyebrow{font-size:12px;font-weight:600;color:var(--ep-ink3)}
.ep .ep-title{font-size:17px;line-height:1.3;font-weight:700;letter-spacing:-0.01em;color:var(--ep-ink)}
.ep .ep-label{font-size:12px;font-weight:600;color:var(--ep-ink3);margin:0 0 8px}
.ep .ep-sub{font-size:12.5px;color:var(--ep-ink2)}
.ep .ep-strong{font-weight:600}
.ep .ep-hint{font-size:12px;color:var(--ep-ink3);margin:-2px 0 10px}
.ep .ep-more{font-size:12.5px;color:var(--ep-ink3);font-weight:600}
.ep .ep-fold{margin-top:6px}
.ep .ep-fold summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--ep-ink2);padding:2px 0;width:fit-content}
.ep .ep-fold[open] summary{margin-bottom:6px}
.ep .ep-tablet{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;padding:12px;border-radius:18px;background:var(--ep-t-bg);color:var(--ep-t-text);min-width:0}
.ep .ep-tablet-solo{width:fit-content}
.ep .ep-tablet-tile{flex:0 0 172px;width:172px}
.ep .ep-tile{border-radius:16px;overflow:hidden;background:var(--ep-t-panel)}
.ep .ep-band{aspect-ratio:2/1;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--ep-t-key)}
.ep .ep-band img{display:block;width:100%;height:100%;object-fit:cover}
.ep .ep-initials{font-size:20px;font-weight:800;color:var(--ep-t-text3)}
.ep .ep-tile-body{display:flex;flex-direction:column;gap:2px;min-height:84px;padding:9px 12px 11px}
.ep .ep-tile-cat{font-size:11px;font-weight:600;color:var(--ep-t-text2)}
.ep .ep-tile-name{font-size:14px;font-weight:700;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ep .ep-tile-foot{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-top:auto;padding-top:6px}
.ep .ep-tile-price{font-size:15px;font-weight:800;white-space:nowrap}
.ep .ep-tile-note{font-size:11px;font-weight:700;line-height:1.25;text-align:right;color:var(--ep-t-text2)}
.ep .ep-sheet{flex:1 1 280px;min-width:0;display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--ep-t-stroke);border-radius:20px;background:var(--ep-t-panel);color:var(--ep-t-text)}
.ep .ep-sheet-head{display:flex;align-items:center;gap:12px}
.ep .ep-square{flex:none;width:72px;height:72px;border-radius:12px;object-fit:cover;background:var(--ep-t-key)}
.ep .ep-sheet-name{flex:1;min-width:0;font-size:18px;font-weight:800;line-height:1.2}
.ep .ep-sheet-price{font-size:16px;font-weight:800;white-space:nowrap}
.ep .ep-opt{display:flex;flex-direction:column;gap:7px}
.ep .ep-opt-name{font-size:12.5px;font-weight:600;color:var(--ep-t-text2)}
.ep .ep-keys{display:flex;flex-wrap:wrap;gap:7px}
.ep .ep-key{position:relative;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;min-height:42px;padding:4px 16px;border-radius:14px;background:var(--ep-t-key);color:var(--ep-t-text);font-size:14px;font-weight:700;line-height:1.15;text-align:center}
.ep .ep-keys-left .ep-key{min-height:54px;min-width:76px;font-size:15px;font-weight:800}
.ep .ep-key.ep-on{background:var(--ep-t-on);color:var(--ep-t-ontext)}
.ep .ep-key-new{box-shadow:inset 0 0 0 2px var(--ep-amber-solid)}
.ep .ep-key-tag{position:absolute;top:-7px;right:-5px;padding:1px 6px;border-radius:8px;background:var(--ep-amber-solid);color:var(--ep-amber-ink);font-size:10px;font-weight:800;line-height:1.3}
.ep .ep-key-more{background:transparent;border:1px dashed var(--ep-t-stroke2);color:var(--ep-t-text3)}
.ep .ep-left{font-size:11px;font-weight:700}
.ep .ep-l-plenty{color:var(--ep-t-text2)}
.ep .ep-l-few{color:var(--ep-amber)}
.ep .ep-l-none,.ep .ep-l-below{color:var(--ep-red)}
.ep .ep-l-nil{color:var(--ep-t-text3)}
.ep .ep-on .ep-left{color:var(--ep-t-onsub)}
.ep .ep-add{display:flex;align-items:center;justify-content:center;min-height:46px;padding:8px 14px;border-radius:14px;background:var(--ep-green);color:var(--ep-green-ink);font-size:14.5px;font-weight:800;text-align:center}
.ep .ep-prod{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px}
.ep .ep-prod .ep-tablet{flex:0 0 auto}
.ep .ep-prod-info{flex:1 1 240px;min-width:0}
.ep .ep-optrow+.ep-optrow{margin-top:10px}
.ep .ep-optrow-name{margin-bottom:5px;font-size:12.5px;font-weight:600;color:var(--ep-ink2)}
.ep .ep-count{font-weight:500;color:var(--ep-ink3)}
.ep .ep-chips{display:flex;flex-wrap:wrap;gap:5px}
.ep .ep-chip{display:inline-flex;align-items:baseline;gap:6px;padding:2px 9px;border:1px solid var(--ep-line);border-radius:999px;background:var(--ep-wash);font-size:12.5px;font-weight:600}
.ep .ep-chip-n{font-size:11px;font-weight:600;color:var(--ep-ink3);font-variant-numeric:tabular-nums}
.ep .ep-grid+.ep-grid{margin-top:14px}
.ep .ep-grid-title{margin-bottom:6px;font-size:13px;font-weight:700}
.ep .ep-scroll{width:fit-content;max-width:100%;overflow-x:auto;border:1px solid var(--ep-line);border-radius:12px;background:var(--ep-surface)}
.ep .ep-scroll table{border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums}
.ep .ep-scroll th{padding:6px 6px;background:var(--ep-wash);font-size:11.5px;font-weight:600;color:var(--ep-ink2);text-align:center;white-space:nowrap}
.ep .ep-scroll thead th{border-bottom:1px solid var(--ep-line)}
.ep .ep-scroll th:first-child{position:sticky;left:0;z-index:1;padding:0 10px;border-right:1px solid var(--ep-line);text-align:left}
.ep .ep-scroll tbody th{font-size:12.5px;color:var(--ep-ink)}
.ep .ep-scroll tbody tr+tr>*{border-top:1px solid var(--ep-line)}
.ep .ep-scroll td{padding:2px;text-align:center}
.ep .ep-q{display:block;width:100%;min-width:42px;height:30px;padding:0 6px;border:0;border-radius:8px;background:transparent;font-size:13.5px;font-weight:700;cursor:pointer}
.ep button.ep-q:hover{background:var(--ep-btn)}
.ep .ep-q-plenty{color:var(--ep-ink)}
.ep .ep-q-few{color:var(--ep-amber)}
.ep .ep-q-none{color:var(--ep-ink3)}
.ep .ep-q-below{color:var(--ep-red)}
.ep button.ep-q-below{background:var(--ep-red-wash)}
.ep button.ep-q-below:hover{background:var(--ep-red-line)}
.ep .ep-nil{color:var(--ep-ink3);opacity:.55}
.ep .ep-rows li{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--ep-line)}
.ep .ep-rows li:first-child{padding-top:0;border-top:0}
.ep .ep-row-main{display:flex;flex-direction:column;min-width:0}
.ep .ep-qty{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.ep .ep-change{display:inline-flex;align-items:baseline;gap:6px;white-space:nowrap;font-variant-numeric:tabular-nums}
.ep .ep-before{color:var(--ep-ink3)}
.ep .ep-after{font-weight:700}
.ep .ep-table{width:100%;border-collapse:collapse;font-size:13px}
.ep .ep-table th{padding:0 10px 6px 0;border-bottom:1px solid var(--ep-line);font-size:11.5px;font-weight:600;color:var(--ep-ink3);text-align:left}
.ep .ep-table td{padding:7px 10px 7px 0;border-bottom:1px solid var(--ep-line);vertical-align:top}
.ep .ep-table tr:last-child td{border-bottom:0}
.ep .ep-table .ep-num{padding-right:0;text-align:right;white-space:nowrap}
.ep .ep-table td.ep-num{font-weight:700;font-variant-numeric:tabular-nums}
.ep .ep-hist-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.ep .ep-now{flex:none;text-align:right;font-size:12px;font-weight:600;color:var(--ep-ink3)}
.ep .ep-now b{display:block;font-size:22px;line-height:1.1;font-weight:800;color:var(--ep-ink);font-variant-numeric:tabular-nums}
.ep .ep-moves li{display:grid;grid-template-columns:86px minmax(0,1fr) auto;align-items:baseline;gap:10px}
.ep .ep-when{font-size:12px;color:var(--ep-ink3);font-variant-numeric:tabular-nums}
.ep .ep-up{color:var(--ep-green-text)}
.ep .ep-down{color:var(--ep-ink)}
.ep .ep-reads{display:flex;flex-direction:column}
.ep .ep-read{display:grid;grid-template-columns:minmax(0,2fr) 16px minmax(0,3fr);align-items:baseline;gap:8px;padding:7px 0;border-top:1px solid var(--ep-line)}
.ep .ep-read:first-child{padding-top:0;border-top:0}
.ep .ep-said{color:var(--ep-ink2)}
.ep .ep-arrow{color:var(--ep-ink3);text-align:center}
.ep .ep-note{margin-top:1px;font-size:12px;color:var(--ep-ink3)}
.ep .ep-new{display:inline-block;margin-left:4px;padding:1px 7px;border-radius:999px;background:var(--ep-amber-solid);color:var(--ep-amber-ink);font-size:10.5px;font-weight:800;line-height:1.35;vertical-align:1px}
.ep .ep-bullets li{position:relative;padding:3px 0 3px 16px}
.ep .ep-bullets li::before{content:"";position:absolute;left:4px;top:.8em;width:5px;height:5px;border-radius:50%;background:var(--ep-ink3)}
.ep .ep-warns{display:flex;flex-direction:column;gap:8px}
.ep .ep-warn{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:12px;font-size:13.5px;font-weight:500;line-height:1.4}
.ep .ep-warn-amber{border:1px solid var(--ep-amber-line);background:var(--ep-amber-wash);color:var(--ep-amber-deep)}
.ep .ep-warn-red{border:1px solid var(--ep-red-line);background:var(--ep-red-wash);color:var(--ep-red)}
.ep .ep-warn-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-top:1px;border-radius:50%;font-size:12px;font-weight:800}
.ep .ep-warn-amber .ep-warn-mark{background:var(--ep-amber-solid);color:var(--ep-amber-ink)}
.ep .ep-warn-red .ep-warn-mark{background:var(--ep-red-solid);color:#FFFFFF}
.ep .ep-typename{display:block;width:100%;height:46px;padding:0 14px;border:1px solid var(--ep-line2);border-radius:12px;background:var(--ep-surface);font-size:15px;font-weight:600;outline:none}
.ep .ep-typename::placeholder{color:var(--ep-ink3);font-weight:500}
.ep .ep-typename:focus{border-color:var(--ep-ink2);box-shadow:0 0 0 3px var(--ep-focus)}
.ep .ep-actions{display:flex;gap:10px}
.ep .ep-btn{min-width:0;min-height:48px;padding:8px 14px;border:0;border-radius:14px;font-size:15px;font-weight:700;line-height:1.2;cursor:pointer}
.ep .ep-cancel{flex:1 1 0;background:var(--ep-btn);color:var(--ep-ink)}
.ep .ep-cancel:hover{background:var(--ep-btn-hover)}
.ep .ep-confirm{flex:2 1 0;background:var(--ep-green);color:var(--ep-green-ink);font-weight:800}
.ep .ep-confirm:hover{background:var(--ep-green-hover)}
.ep .ep-confirm.ep-confirm-red{background:var(--ep-red-solid);color:#FFFFFF}
.ep .ep-confirm.ep-confirm-red:hover{background:var(--ep-red-hover)}
.ep .ep-foot{margin-top:-4px;font-size:12px;color:var(--ep-ink3)}
.ep .ep-foot a{color:var(--ep-ink2);text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere}
.ep .ep-done-head{display:flex;align-items:center;gap:10px;min-width:0}
.ep .ep-check{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--ep-green);color:var(--ep-green-ink)}
.ep .ep-check svg{width:16px;height:16px}
`;
