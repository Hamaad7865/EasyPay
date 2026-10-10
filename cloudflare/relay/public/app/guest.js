// The guest's page. Its address is /<store>/<table>: it reads the menu the
// restaurant's till published, builds an order on the phone, sends it, and
// waits to be told what the cashier answered. No library.
//
// Nothing on the phone is trusted by the till: a price shown here is the
// menu's, and the till works the bill out from its own.
(() => {
  "use strict";

  const app = document.getElementById("app");
  const [, STORE = "", TABLE = ""] = location.pathname.split("/");
  const api = (path, init) => fetch(`/api/${STORE}${path}`, init);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---- drawings ----

  const svg = (d, size = 22, width = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" stroke-width="${width}"><path d="${d}"/></svg>`;
  const I = {
    search: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M16 16l4 4",
    plus: "M12 5v14M5 12h14", minus: "M5 12h14", close: "M6 6l12 12M18 6L6 18",
    back: "M19 12H5M11 6l-6 6 6 6", go: "M9 6l6 6-6 6", check: "M5 12.5l4.5 4.5L19 7.5",
    clock: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M12 7.5V12l3 2",
    leaf: "M5 19c0-8 5-13 14-13 0 9-5 13.5-12.5 13M5 19l7-7.5",
    table: "M4 8h16M6 8v11M18 8v11M9 13h6",
    all: "M5 5h5.5v5.5H5zM13.5 5H19v5.5h-5.5zM5 13.5h5.5V19H5zM13.5 13.5H19V19h-5.5z",
  };
  // One line drawing for each kind of category. It stands where a dish has no photo yet.
  const KINDS = [
    [/starter|entr[ée]e|soup|salad|snack|gajack/i, "M3.5 17.5h17M5.5 17.5a6.5 6.5 0 0 1 13 0M12 11V8.5"],
    [/street|puri|roti|farata|fried|frit/i, "M12 3c1 3.5 5 5 5 9.5a5 5 0 0 1-10 0c0-1.8.8-3 1.8-4 .3 1.6 1.2 2.3 2 2.5C10 8.5 10.8 5.5 12 3z"],
    [/rice|noodle|mine|riz|wok|pasta|p[âa]tes/i, "M4 12.5h16M4.5 12.5a7.5 7.5 0 0 0 15 0M8 12.5L15 4M11.5 12.5L18.5 5"],
    [/fish|sea|grill|poisson|fruits de mer|crevette/i, "M7 12c2-3.2 4.6-4.8 7.2-4.8 2.6 0 4.7 1.7 6.3 4.8-1.6 3.1-3.7 4.8-6.3 4.8-2.6 0-5.2-1.6-7.2-4.8zM7 12L3.5 8.5v7L7 12M16.5 11.4v.2"],
    [/dessert|sweet|cake|g[âa]teau|glace|ice cream|p[âa]tisserie/i, "M7.5 10a4.5 4.5 0 0 1 9 0M6.5 10h11L12 20.5 6.5 10z"],
    [/bar|beer|bi[èe]re|wine|vin|cocktail|spirit|rhum|rum|alcohol/i, "M5 5.5h14L12 13 5 5.5zM12 13v6.5M8.5 19.5h7"],
    [/drink|boisson|juice|jus|soft|tea|th[ée]|coffee|caf[ée]|water|eau/i, "M6.5 8h11l-1.3 11.5H7.8L6.5 8zM13 8l1.8-4.5H17"],
  ];
  const BOWL = "M4 12h16M4.5 12a7.5 7.5 0 0 0 15 0M9 4.5c-.8 1 .8 2 0 3M13.5 4.5c-.8 1 .8 2 0 3";
  const drawingFor = (name) => (KINDS.find(([re]) => re.test(name || "")) || [0, BOWL])[1];

  // A category's colour, soft under a drawing and deep for the drawing itself.
  const OKLCH = !!(window.CSS && CSS.supports && CSS.supports("color", "oklch(0.5 0.1 100)"));
  function hues(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return { ok: 250, hsl: 215, grey: false };
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const R = lin(r), G = lin(g), B = lin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { ok: Math.round((Math.atan2(Bb, A) * 180 / Math.PI + 360) % 360), hsl: Math.round((h * 60 + 360) % 360), grey: d < 0.06 };
  }
  function look(hex) {
    const h = hues(hex);
    if (h.grey) return { tint: "#ecefe8", tone: "#3f4a42", fill: "#3f4a42" };
    return OKLCH
      ? { tint: `oklch(0.94 0.045 ${h.ok})`, tone: `oklch(0.44 0.11 ${h.ok})`, fill: `oklch(0.42 0.11 ${h.ok})` }
      : { tint: `hsl(${h.hsl} 45% 91%)`, tone: `hsl(${h.hsl} 48% 30%)`, fill: `hsl(${h.hsl} 48% 29%)` };
  }
  const paint = (l) => `style="--tint:${l.tint};--tone:${l.tone}"`;

  // ---- what the page knows ----

  const S = {
    menu: null, open: false, table: null, at: 0,
    items: new Map(), groups: new Map(), cats: new Map(),
    screen: "menu", cat: null, veg: false, q: "",
    cart: [], sheet: null, last: null, trouble: "", sending: false,
  };
  const KEEP = `easypay:${STORE}:${TABLE}`;
  const save = () => { try { localStorage.setItem(KEEP, JSON.stringify({ cart: S.cart, last: S.last, at: Date.now() })); } catch (e) { /* a phone that keeps nothing still orders */ } };
  const recall = () => {
    try {
      const kept = JSON.parse(localStorage.getItem(KEEP) || "null");
      if (!kept || Date.now() - kept.at > 6 * 60 * 60 * 1000) return;
      if (Array.isArray(kept.cart)) S.cart = kept.cart;
      if (kept.last && kept.last.id) S.last = kept.last;
    } catch (e) { /* nothing kept */ }
  };

  function money(cents) {
    const d = S.menu.decimals, v = cents / Math.pow(10, d);
    return S.menu.currency + " " + v.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(v) ? 0 : d, maximumFractionDigits: d });
  }
  const plain = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const isVeg = (it) => it.tags.some((t) => /^veg/i.test(t));
  const lookOf = (it) => S.cats.get(it.cat)?.look || look(it.color);
  const drawOf = (it) => S.cats.get(it.cat)?.draw || BOWL;
  const optsOf = (it) => it.groups.map((g) => S.groups.get(g)).filter(Boolean);
  const unit = (it, mods) => it.price + optsOf(it).reduce((sum, g) => sum + g.opts.reduce((s, o) => s + (mods.includes(o.id) ? o.price : 0), 0), 0);
  const modNames = (it, mods) => optsOf(it).flatMap((g) => g.opts.filter((o) => mods.includes(o.id)).map((o) => o.name));
  const lineKey = (id, mods, note) => id + "|" + mods.slice().sort().join(",") + "|" + note;
  const inCart = (id) => S.cart.reduce((n, l) => n + (l.item === id ? l.qty : 0), 0);
  const count = () => S.cart.reduce((n, l) => n + l.qty, 0);
  const total = () => S.cart.reduce((n, l) => n + unit(S.items.get(l.item), l.mods) * l.qty, 0);
  const tableName = () => (S.table ? S.table.name + (S.table.area ? " · " + S.table.area : "") : "");

  function take(body) {
    S.menu = body.menu; S.open = !!body.open; S.table = body.table; S.at = Date.now();
    S.items = new Map(S.menu.items.map((i) => [i.id, i]));
    S.groups = new Map(S.menu.groups.map((g) => [g.id, g]));
    S.cats = new Map(S.menu.categories.map((c) => [c.id, { ...c, look: look(c.color), draw: drawingFor(c.name) }]));
    // what is no longer on the menu, or sold out since, leaves the order
    const before = S.cart.length;
    S.cart = S.cart.filter((l) => {
      const it = S.items.get(l.item);
      if (!it || it.out || !Array.isArray(l.mods)) return false;
      const known = new Set(optsOf(it).flatMap((g) => g.opts.map((o) => o.id)));
      return l.mods.every((m) => known.has(m));
    });
    if (S.cat && !S.cats.has(S.cat)) S.cat = null;
    document.title = S.menu.name + (S.table ? " · " + S.table.name : "");
    return before !== S.cart.length;
  }

  // The menu, and this table's name: a card's address names one table and the
  // page is told of no other. Answers "ok", or why there is nothing to show:
  // "unknown" (no restaurant at this address) or "table" (not one of its tables).
  async function load() {
    const r = await api("/menu/" + encodeURIComponent(TABLE));
    if (r.status === 404) { S.table = null; return (await r.json().catch(() => ({}))).code === "table" ? "table" : "unknown"; }
    if (!r.ok) throw new Error("menu " + r.status);
    take(await r.json());
    return "ok";
  }

  // ---- screens ----

  function says(title, words, key) {
    app.innerHTML = `<div class="says"><span class="ring">${svg(I.table, 30, 1.8)}</span><h1>${esc(title)}</h1><p>${esc(words)}</p>${key ? `<button type="button" class="key" data-a="reload">${esc(key)}</button>` : ""}</div>`;
  }

  function tileBox(it, cls = "") {
    const n = inCart(it.id), has = it.groups.length > 0;
    const stepper = !it.out && !has && n > 0;
    return `<div class="tile-box"><div class="tile" ${paint(lookOf(it))}>${svg(drawOf(it), cls === "fav" ? 44 : 36, 1.5)}</div>${
      it.out ? `<span class="soldout">Sold out</span>` : ""}${
      !it.out && has && n > 0 ? `<span class="count">${n}</span>` : ""}${
      !it.out && !stepper ? `<button type="button" class="add" aria-label="Add ${esc(it.name)} to the order" data-a="add" data-id="${esc(it.id)}">${svg(I.plus, 22, 2.4)}</button>` : ""}${
      stepper ? `<div class="stepper"><button type="button" aria-label="One less" data-a="dec" data-id="${esc(it.id)}">${svg(I.minus, 18, 2.4)}</button><span>${n}</span><button type="button" aria-label="One more" data-a="add" data-id="${esc(it.id)}">${svg(I.plus, 18, 2.4)}</button></div>` : ""}</div>`;
  }
  const card = (it) => `<div class="card${it.out ? " is-out" : ""}"><div class="card-words"><b>${esc(it.name)}</b><div class="card-marks">${
    isVeg(it) ? `<span class="vegmark">${svg(I.leaf, 13, 2.4)}<span>Vegetarian</span></span>` : ""}${
    it.groups.length && !it.out ? `<span class="opts-hint">with options</span>` : ""}</div><span class="price">${money(it.price)}</span></div>${tileBox(it)}</div>`;

  function listHtml() {
    const q = plain(S.q).trim();
    const shown = (it) => (!q || plain(it.name).includes(q)) && (!S.veg || isVeg(it));
    const sections = [];
    const groupsOf = [...S.menu.categories.map((c) => [c.id, c.name]), [null, "More"]];
    for (const [cid, name] of groupsOf) {
      if (S.cat !== null && S.cat !== cid) continue;
      const items = S.menu.items.filter((it) => it.cat === cid && shown(it));
      if (!items.length) continue;
      const c = S.cats.get(cid);
      sections.push(`<section class="section"><div class="section-head"><span ${paint(c ? c.look : look(null))}>${svg(c ? c.draw : BOWL, 22, 1.9)}</span><h2>${esc(name)}</h2></div>${items.map(card).join("")}</section>`);
    }
    const fav = S.cat === null && !q && !S.veg ? S.menu.popular.map((id) => S.items.get(id)).filter(Boolean) : [];
    return (fav.length ? `<section class="popular"><h2>Most ordered</h2><div class="row">${fav.map((it) => `<div class="fav">${tileBox(it, "fav")}<b>${esc(it.name)}</b><span>${money(it.price)}</span></div>`).join("")}</div></section>` : "")
      + `<div class="list">${sections.join("") || `<div class="none"><b>Nothing matches</b><span>Try another word, or take a filter off.</span></div>`}</div>`;
  }

  function chipsHtml() {
    const anyVeg = S.menu.items.some(isVeg);
    const chip = (id, label, draw, fill) => `<button type="button" class="chip" data-a="cat" data-id="${esc(id ?? "")}" aria-pressed="${S.cat === id}"${fill ? ` style="--fill:${fill}"` : ""}>${svg(draw, 18)}<span>${esc(label)}</span></button>`;
    return (anyVeg ? `<button type="button" class="chip veg" data-a="veg" aria-pressed="${S.veg}">${svg(I.leaf, 18)}<span>Vegetarian</span></button><i aria-hidden="true"></i>` : "")
      + chip(null, "All", I.all, null)
      + S.menu.categories.filter((c) => S.menu.items.some((i) => i.cat === c.id)).map((c) => chip(c.id, c.name, S.cats.get(c.id).draw, S.cats.get(c.id).look.fill)).join("");
  }

  const LAST = { waiting: "Waiting for staff to confirm", accepted: "Confirmed", declined: "Not taken", expired: "Not answered" };
  function noticeHtml() {
    return (S.open ? "" : `<p class="closed" role="status">Not taking orders from the table right now. Please ask a member of staff.</p>`)
      + (S.trouble ? `<p class="closed" role="alert">${esc(S.trouble)}</p>` : "")
      + (S.last ? `<button type="button" class="last" data-a="status"><span><small>Your last order</small><b>${LAST[S.last.status] || ""}</b></span>${svg(I.go, 20)}</button>` : "");
  }

  function drawBar(pop) {
    const bar = document.getElementById("bar");
    if (!bar) return;
    const n = count();
    bar.classList.toggle("is-on", n > 0);
    bar.disabled = n === 0;
    bar.setAttribute("aria-hidden", String(n === 0));
    bar.innerHTML = `<i>${n}</i><b>View order</b><span>${money(total())}</span>`;
    if (pop) { bar.classList.remove("is-pop"); void bar.offsetWidth; bar.classList.add("is-pop"); }
  }

  function drawMenu() {
    S.screen = "menu";
    document.body.style.overflow = "";
    const words = S.menu.name.split(/\s+/).filter(Boolean);
    const initials = (words.length > 1 ? words[0][0] + words[1][0] : S.menu.name.slice(0, 2)).toUpperCase();
    app.innerHTML = `<div class="menu">
      <header class="top"><div class="top-row"><span class="badge" aria-hidden="true">${esc(initials)}</span><span class="pill">${esc(tableName())}</span></div>
        <div><h1>${esc(S.menu.name)}</h1><p>Order from your seat. We confirm it and bring it over, and you pay at the table as usual.</p></div></header>
      <label class="search">${svg(I.search, 20)}<input type="search" id="q" aria-label="Search the menu" placeholder="Search the menu" autocomplete="off" value="${esc(S.q)}"></label>
      <div id="notice">${noticeHtml()}</div>
      <nav class="chips" id="chips" aria-label="Filter the menu">${chipsHtml()}</nav>
      <main id="list">${listHtml()}</main>
      <footer class="foot"><p>${esc(S.menu.note)}</p><small>Powered by EasyPay</small></footer>
    </div>
    <button type="button" class="bar" id="bar" data-a="order"></button>
    <div id="veil"></div>`;
    drawBar(false);
  }
  const redrawList = () => { const el = document.getElementById("list"); if (el) el.innerHTML = listHtml(); };
  const redrawChips = () => { const el = document.getElementById("chips"); if (el) el.innerHTML = chipsHtml(); };
  const redrawNotice = () => { const el = document.getElementById("notice"); if (el) el.innerHTML = noticeHtml(); };

  // ---- a dish's options ----

  const rule = (g) => (g.min > 0 ? "Choose " + g.min : g.max > 1 ? "Optional, up to " + g.max : "Optional");
  function sheetHtml() {
    const sh = S.sheet, it = S.items.get(sh.id), groups = optsOf(it);
    const missing = groups.filter((g) => g.opts.filter((o) => sh.mods.includes(o.id)).length < g.min).map((g) => g.name.toLowerCase());
    return `<button type="button" class="veil-shade" aria-label="Close" data-a="shut"></button>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(it.name)}">
      <div class="sheet-scroll" id="sheet-scroll">
        <div class="sheet-top" ${paint(lookOf(it))}>${svg(drawOf(it), 64, 1.3)}<button type="button" class="round" aria-label="Close" data-a="shut">${svg(I.close, 18, 2.2)}</button></div>
        <div class="sheet-body">
          <div class="sheet-name"><h2>${esc(it.name)}</h2><span>${money(it.price)}</span></div>
          ${groups.map((g) => `<div class="group"><div class="group-head"><h3>${esc(g.name)}</h3><span>${rule(g)}</span></div>${
            g.opts.map((o) => { const on = sh.mods.includes(o.id); return `<button type="button" class="opt${g.max === 1 ? " one" : ""}" aria-pressed="${on}" data-a="pick" data-g="${esc(g.id)}" data-id="${esc(o.id)}"><i>${on ? svg(I.check, 14, 3.2) : ""}</i><b>${esc(o.name)}</b>${o.price > 0 ? `<span>+ ${money(o.price)}</span>` : ""}</button>`; }).join("")}</div>`).join("")}
          <label class="note"><span>Note for the kitchen</span><textarea id="note" rows="2" maxlength="140" placeholder="An allergy, no onion, sauce on the side">${esc(sh.note)}</textarea></label>
        </div>
      </div>
      <div class="sheet-foot">${missing.length ? `<p class="need">Still to choose: ${esc(missing.join(", "))}</p>` : ""}
        <div class="sheet-keys"><div class="qty"><button type="button" aria-label="One less" data-a="sheet-less">${svg(I.minus, 18, 2.2)}</button><span>${sh.qty}</span><button type="button" aria-label="One more" data-a="sheet-more">${svg(I.plus, 18, 2.2)}</button></div>
        <button type="button" class="key" data-a="sheet-add"${missing.length ? " disabled" : ""}><b>Add to order</b><span>${money(unit(it, sh.mods) * sh.qty)}</span></button></div>
      </div>
    </div>`;
  }
  function drawSheet(first) {
    const veil = document.getElementById("veil");
    if (!veil) return;
    if (!S.sheet) { veil.className = ""; veil.innerHTML = ""; return; }
    const kept = document.getElementById("sheet-scroll")?.scrollTop || 0;
    veil.innerHTML = sheetHtml();
    document.getElementById("sheet-scroll").scrollTop = kept;
    // the menu behind does not scroll while the options are up
    if (first) { document.body.style.overflow = "hidden"; veil.className = "veil"; requestAnimationFrame(() => requestAnimationFrame(() => veil.classList.add("is-in"))); }
  }
  function shut() {
    const veil = document.getElementById("veil");
    if (!S.sheet || !veil) return;
    veil.classList.remove("is-in");
    document.body.style.overflow = "";
    S.sheet = null;
    setTimeout(() => { if (!S.sheet) drawSheet(); }, 290);
  }

  // ---- the order, and where it stands ----

  function drawOrder() {
    S.screen = "order";
    const lines = S.cart.map((l) => {
      const it = S.items.get(l.item), mods = modNames(it, l.mods);
      return `<div class="line"><span class="tile" ${paint(lookOf(it))}>${svg(drawOf(it), 26, 1.7)}</span><div class="line-words"><b>${esc(it.name)}</b>${
        mods.length ? `<span>${esc(mods.join(", "))}</span>` : ""}${l.note ? `<em>${esc(l.note)}</em>` : ""}<i>${money(unit(it, l.mods) * l.qty)}</i></div>
        <div class="qty"><button type="button" aria-label="One less" data-a="line-less" data-id="${esc(l.key)}">${svg(I.minus, 18, 2.2)}</button><span>${l.qty}</span><button type="button" aria-label="One more" data-a="line-more" data-id="${esc(l.key)}">${svg(I.plus, 18, 2.2)}</button></div></div>`;
    }).join("");
    app.innerHTML = `<div class="page">
      <div class="page-top"><button type="button" aria-label="Back to the menu" data-a="menu">${svg(I.back, 22)}</button><h1>Your order</h1><span>${esc(S.table.name)}</span></div>
      <div class="lines">${lines}<button type="button" class="more" data-a="menu">${svg(I.plus, 18, 2.2)}<span>Add more items</span></button></div>
      <div class="total">
        <div class="total-row"><b>Total</b><span>${money(total())}</span></div>
        ${S.trouble ? `<p class="trouble" role="alert">${esc(S.trouble)}</p>` : ""}
        <p>${S.open ? "Nothing is charged here: you pay at the table as usual." : "Not taking orders from the table right now. Please ask a member of staff."}</p>
        <button type="button" class="key wide" data-a="send"${S.open && !S.sending ? "" : " disabled"}>${S.sending ? "Sending…" : "Send order to staff"}</button>
      </div></div>`;
    scrollTo(0, 0);
  }

  const STANDS = {
    waiting: ["waits", I.clock, "Order sent", "Waiting for a member of staff to confirm it. Keep this page open: it updates by itself."],
    accepted: ["done", I.check, "Confirmed", "A member of staff has taken your order. It is on the bill for your table, and you pay at the table as usual."],
    declined: ["no", I.close, "Not taken", "A member of staff could not take this order. Please ask them, or order again."],
    expired: ["no", I.clock, "Not answered", "Nobody confirmed this order in time. Please ask a member of staff."],
  };
  function drawStatus() {
    S.screen = "status";
    const last = S.last, [mark, draw, title, words] = STANDS[last.status] || STANDS.waiting;
    app.innerHTML = `<div class="page"><div class="stands">
      <div class="stands-top"><div class="mark ${mark}"><span>${svg(draw, mark === "waits" ? 28 : 32, mark === "waits" ? 1.8 : 2.4)}</span></div>
        <div><small>${esc(tableName())}</small><h1 role="status">${title}</h1><p>${esc(last.status === "declined" && last.reason ? last.reason : words)}</p></div></div>
      <div class="sent">${last.lines.map((l) => `<div class="sent-line"><span class="tile" ${paint(l.look)}>${svg(l.draw, 22, 1.8)}</span><div><b>${esc(l.name)}</b>${l.says ? `<span>${esc(l.says)}</span>` : ""}</div><i>× ${l.qty}</i></div>`).join("")}</div>
    </div><div class="page-foot"><button type="button" class="key wide${last.status === "waiting" ? " line" : ""}" data-a="menu">${
      last.status === "waiting" ? "Add more items" : last.status === "accepted" ? "Order something else" : "Back to the menu"}</button></div></div>`;
    scrollTo(0, 0);
  }

  // ---- what is done ----

  function add(it, mods, note, qty, pop = true) {
    const key = lineKey(it.id, mods, note);
    const line = S.cart.find((l) => l.key === key);
    if (line) line.qty = Math.min(20, line.qty + qty);
    else S.cart.push({ key, item: it.id, qty, mods, note });
    S.trouble = "";
    save();
    redrawList();
    drawBar(pop);
  }
  function bump(key, by) {
    const line = S.cart.find((l) => l.key === key);
    if (!line) return;
    line.qty = Math.min(20, line.qty + by);
    if (line.qty <= 0) S.cart = S.cart.filter((l) => l !== line);
    S.trouble = "";
    save();
  }
  function pick(gid, oid) {
    const sh = S.sheet, g = S.groups.get(gid);
    if (!sh || !g) return;
    const of = g.opts.map((o) => o.id), mine = sh.mods.filter((m) => of.includes(m)), on = mine.includes(oid);
    let next = mine;
    if (g.max === 1) next = on && g.min === 0 ? [] : [oid];
    else if (on) next = mine.filter((m) => m !== oid);
    else if (mine.length < g.max) next = mine.concat(oid);
    sh.mods = sh.mods.filter((m) => !of.includes(m)).concat(next);
    drawSheet();
  }

  async function send() {
    if (S.sending || !S.cart.length) return;
    S.sending = true; S.trouble = ""; drawOrder();
    const shown = S.cart.map((l) => { const it = S.items.get(l.item); return { name: it.name, qty: l.qty, says: modNames(it, l.mods).concat(l.note ? [l.note] : []).join(", "), look: lookOf(it), draw: drawOf(it) }; });
    let r, body = {};
    try {
      r = await api("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ table: TABLE, lines: S.cart.map((l) => ({ item: l.item, qty: l.qty, mods: l.mods, note: l.note })) }) });
      body = await r.json().catch(() => ({}));
    } catch (e) { r = null; }
    S.sending = false;
    if (r && r.ok && body.id) {
      S.last = { id: body.id, status: "waiting", reason: "", lines: shown, at: Date.now() };
      S.cart = [];
      save();
      drawStatus();
      return watch();
    }
    S.trouble = r ? body.error || "The order could not be sent. Please try again." : "No connection. Check your signal and try again.";
    if (body.code === "closed") S.open = false;
    // the menu changed under the order: read it again, and what is gone leaves the order
    if (body.code === "gone" || body.code === "options" || body.code === "table") { try { await load(); save(); } catch (e) { /* the message stands */ } }
    if (!S.table) return says("This table's code is no longer in use", "Please ask a member of staff for the menu.");
    S.cart.length ? drawOrder() : drawMenu();
  }

  // ---- being told the answer ----

  let sock = null, beat = 0, later = 0, tries = 0;
  const waiting = () => !!S.last && S.last.status === "waiting";
  function heard(a) {
    if (!S.last || !a || a.id !== S.last.id || a.status === S.last.status) return;
    S.last.status = a.status; S.last.reason = a.reason || "";
    save();
    if (S.screen === "status") drawStatus(); else redrawNotice();
    if (!waiting()) hush();
  }
  function hush() { clearInterval(beat); clearTimeout(later); if (sock) { const s = sock; sock = null; try { s.close(); } catch (e) { /* closed */ } } }
  async function check() {
    try {
      const r = await api("/orders/" + S.last.id);
      if (r.status === 404) return heard({ id: S.last.id, status: "expired" });
      if (r.ok) heard(await r.json());
    } catch (e) { /* tried again later */ }
  }
  function watch() {
    hush();
    if (!waiting()) return;
    try { sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/${STORE}/orders/${S.last.id}`); } catch (e) { sock = null; }
    if (!sock) return again();
    const mine = sock;
    mine.onopen = () => { tries = 0; };
    mine.onmessage = (e) => { if (e.data !== "pong") { try { heard(JSON.parse(e.data)); } catch (err) { /* not for us */ } } };
    mine.onclose = () => { if (sock === mine) { sock = null; clearInterval(beat); if (waiting()) again(); } };
    // keeps the line from being dropped; the relay answers without waking anything
    beat = setInterval(() => { if (mine.readyState === 1) mine.send("ping"); }, 40000);
  }
  // the line dropped, or could not be opened: ask once, then listen again, less and less often
  function again() {
    clearTimeout(later);
    if (tries++ > 40) return;
    later = setTimeout(async () => { await check(); if (waiting()) watch(); }, Math.min(3000 + tries * 2000, 15000));
  }
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !S.menu) return;
    if (waiting()) { await check(); if (waiting() && !sock) watch(); }
    // a phone put down for a while and picked up again reads the menu afresh
    if (Date.now() - S.at > 5 * 60 * 1000 && !S.sheet && !S.sending) {
      try { if ((await load()) === "ok" && S.table) { save(); S.screen === "menu" ? drawMenu() : S.screen === "order" ? (S.cart.length ? drawOrder() : drawMenu()) : 0; } } catch (e) { /* as it was */ }
    }
  });

  // ---- taps and typing ----

  app.addEventListener("click", (e) => {
    const el = e.target.closest("[data-a]");
    if (!el || el.disabled) return;
    const a = el.dataset.a, id = el.dataset.id;
    if (a === "reload") return location.reload();
    if (!S.menu) return;
    if (a === "add") {
      const it = S.items.get(id);
      if (!it || it.out) return;
      if (it.groups.length) { S.sheet = { id, qty: 1, mods: [], note: "" }; return drawSheet(true); }
      return add(it, [], "", 1);
    }
    if (a === "dec") { bump(lineKey(id, [], ""), -1); redrawList(); return drawBar(false); }
    if (a === "cat") { S.cat = id || null; redrawChips(); redrawList(); return; }
    if (a === "veg") { S.veg = !S.veg; redrawChips(); redrawList(); return; }
    if (a === "order") {
      if (!S.cart.length) return;
      drawOrder();
      // when orders were not being taken, that is asked again here; a menu that
      // changed since is found out at sending, which says what is gone
      if (!S.open) load().then((found) => { if (found === "ok" && S.table && S.screen === "order") { save(); S.cart.length ? drawOrder() : drawMenu(); } }).catch(() => {});
      return;
    }
    if (a === "menu") return drawMenu();
    if (a === "status") return S.last ? drawStatus() : 0;
    if (a === "shut") return shut();
    if (a === "pick") return pick(el.dataset.g, id);
    if (a.startsWith("sheet-") && !S.sheet) return; // a tap on options that are already going away
    if (a === "sheet-less" || a === "sheet-more") { S.sheet.qty = Math.max(1, Math.min(20, S.sheet.qty + (a === "sheet-more" ? 1 : -1))); return drawSheet(); }
    if (a === "sheet-add") { const sh = S.sheet, it = S.items.get(sh.id); shut(); return add(it, sh.mods, sh.note.trim(), sh.qty); }
    if (a === "line-less" || a === "line-more") { bump(id, a === "line-more" ? 1 : -1); return S.cart.length ? drawOrder() : drawMenu(); }
    if (a === "send") return send();
  });
  app.addEventListener("input", (e) => {
    if (e.target.id === "q") { S.q = e.target.value; redrawList(); }
    if (e.target.id === "note" && S.sheet) S.sheet.note = e.target.value.slice(0, 140);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.sheet) shut(); });

  // ---- start ----

  (async () => {
    if (!/^[a-z2-7]{16}$/.test(STORE) || !/^[A-Za-z0-9_-]{1,64}$/.test(TABLE)) return says("Scan the code on your table", "This page opens from the code on a table. Scan it with your phone's camera.");
    let found;
    try { found = await load(); } catch (e) { return says("No connection", "The menu could not be opened. Check your signal and try again.", "Try again"); }
    if (found === "unknown") return says("This code is not in use", "Please ask a member of staff for the menu.");
    if (found === "table") return says("This table's code is not in use", "Please ask a member of staff for the menu.");
    recall();
    take({ menu: S.menu, open: S.open, table: S.table }); // what was kept is checked against today's menu
    if (S.last && S.last.status === "waiting") { drawStatus(); watch(); check(); } else drawMenu();
  })();
})();
