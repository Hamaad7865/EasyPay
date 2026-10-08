// EasyPay, the public site. No library: the bar, the dots behind the page,
// the tablet that changes screen, the things that arrive as you scroll, and
// the demo form.
(() => {
  "use strict";

  const cfg = window.EASYPAY || {};
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mouse = matchMedia("(hover: hover) and (pointer: fine)").matches;

  // ---- the site's own details (js/config.js) ----

  const digits = String(cfg.whatsapp || "").replace(/\D/g, "");
  if (cfg.signInUrl) {
    for (const a of $$("[data-signin]")) { a.href = cfg.signInUrl; a.hidden = false; }
  }
  // the number as it is said: +230 5252 5270 for a Mauritian mobile
  const spoken = /^230\d{8}$/.test(digits) ? `+230 ${digits.slice(3, 7)} ${digits.slice(7)}` : "+" + digits;
  const direct = $("[data-direct]");
  if (direct && (cfg.email || digits)) {
    const bits = [];
    if (digits) bits.push(`<a href="https://wa.me/${digits}">WhatsApp</a> or call <a href="tel:+${digits}">${spoken}</a>`);
    if (cfg.email) bits.push(`<a href="mailto:${cfg.email}">${cfg.email}</a>`);
    direct.innerHTML = "Or reach us: " + bits.join(" · ");
    direct.hidden = false;
  }
  // the same number at the foot of the page
  if (digits) {
    for (const a of $$("[data-call]")) { a.href = "tel:+" + digits; a.textContent = spoken; a.hidden = false; }
  }

  // ---- the bar: loose at the top of the page, a glass pill once it moves ----

  const head = $(".site-head");
  const sheet = $("#nav-sheet");
  const toggle = $(".nav-toggle");
  const stick = () => head.classList.toggle("is-stuck", scrollY > 8);
  stick();
  addEventListener("scroll", stick, { passive: true });

  const openSheet = (open) => {
    sheet.hidden = !open;
    head.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => openSheet(sheet.hidden));
  sheet.addEventListener("click", (e) => { if (e.target.closest("a")) openSheet(false); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) { openSheet(false); toggle.focus(); } });
  matchMedia("(min-width: 1081px)").addEventListener("change", () => openSheet(false));

  // "Product" opens its panel under the pointer, or at a tap or a key press
  const drop = $(".nav-drop");
  if (drop) {
    const key = $(".nav-key", drop);
    let shut = 0, hovered = 0;
    const isOpen = () => drop.classList.contains("is-open");
    const open = (on) => {
      clearTimeout(shut);
      drop.classList.toggle("is-open", on);
      key.setAttribute("aria-expanded", String(on));
    };
    if (mouse) {
      drop.addEventListener("pointerenter", () => { hovered = Date.now(); open(true); });
      drop.addEventListener("pointerleave", () => { shut = setTimeout(() => open(false), 180); });
    }
    // a click that follows the pointer's arrival is not a second wish to close it
    key.addEventListener("click", () => { if (Date.now() - hovered > 400) open(!isOpen()); });
    drop.addEventListener("click", (e) => { if (e.target.closest("a")) open(false); });
    drop.addEventListener("focusout", (e) => { if (!drop.contains(e.relatedTarget)) open(false); });
    document.addEventListener("click", (e) => { if (!drop.contains(e.target)) open(false); });
    addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) { open(false); key.focus(); } });
  }

  // ---- a restaurant's page or a shop's ----
  //
  // <html data-for> says which, and the stylesheet shows the pieces marked for
  // it (data-only). It is set before the page is drawn, by the script in the
  // head. From here it changes when the visitor picks in the hero, or follows
  // a link to a section that belongs to the other one.

  const root = document.documentElement;
  const picked = [];
  const whose = () => (root.dataset.for === "shop" ? "shop" : "restaurant");
  const note = $('textarea[name="note"]');
  if (note) note.dataset.restaurant = note.placeholder;
  const dress = () => {
    for (const k of $$("[data-pick]")) k.setAttribute("aria-pressed", String(k.dataset.pick === whose()));
    if (note) note.placeholder = note.dataset[whose()] || note.placeholder;
  };
  const setFor = (who) => {
    if (who === whose()) return;
    root.dataset.for = who;
    try { localStorage.setItem("easypay-for", who); } catch (e) { /* a visit that keeps nothing still works */ }
    dress();
    for (const tell of picked) tell(who);
    // the page is another height now: the dots behind it are laid out again
    dispatchEvent(new Event("resize"));
  };
  dress();
  for (const k of $$("[data-pick]")) {
    k.addEventListener("click", () => {
      setFor(k.dataset.pick);
      // an address that can be sent to a shop's owner
      history.replaceState(null, "", k.dataset.pick === "shop" ? "#shop" : location.pathname + location.search);
    });
  }
  // a link to a section of the other one shows that one first, so the section is there to go to
  const belongs = (hash) => {
    if (hash === "#shop") return "shop";
    const part = hash.length > 1 && document.getElementById(hash.slice(1));
    const only = part && part.closest("[data-only]");
    return only ? only.dataset.only : "";
  };
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    const who = a && belongs(a.getAttribute("href"));
    if (who) setFor(who);
  }, true);
  addEventListener("hashchange", () => { const who = belongs(location.hash); if (who) setFor(who); });

  // the link of the part of the page being read
  const links = $$(".nav-links a");
  const parts = links.map((a) => $(a.getAttribute("href"))).filter(Boolean);
  if (parts.length && "IntersectionObserver" in window) {
    const seen = new Set();
    const spy = new IntersectionObserver((entries) => {
      for (const e of entries) e.isIntersecting ? seen.add(e.target) : seen.delete(e.target);
      const here = parts.find((p) => seen.has(p));
      for (const a of links) a.classList.toggle("is-here", !!here && a.getAttribute("href") === "#" + here.id);
    }, { rootMargin: "-45% 0px -50% 0px" });
    for (const p of parts) spy.observe(p);
  }

  // ---- arriving: each piece waits until the reader reaches it ----

  const waiting = $$("[data-reveal]");
  if (still || !("IntersectionObserver" in window)) {
    for (const el of waiting) el.classList.add("is-in");
  } else {
    const io = new IntersectionObserver((entries) => {
      // pieces that arrive together come in one after the other
      let n = 0;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.style.setProperty("--d", `${Math.min(n++, 5) * 70}ms`);
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.1 });
    for (const el of waiting) io.observe(el);
  }

  // ---- the tablet: a sale played by itself ----
  //
  // A film of a few chapters for a restaurant, and another for a shop. A
  // chapter is a list of things done one after the other: say a line, tap
  // something (a dot shows where), change what the screen holds, wait. Each
  // chapter first puts its screens back as they are written in the page, so it
  // can be played on its own, from its key, and the film loops cleanly.
  //
  // It plays only while it is on screen and the tab is in front, and never for
  // a visitor who asked for less motion: they get the screens as written, and
  // the keys still turn them.

  (() => {
    const stage = $(".stage--hero");
    if (!stage) return;
    const body = $(".t-body", stage);
    const cap = $(".film-cap", stage);
    const hand = $(".f-hand", stage);
    const sheet = $(".f-sheet", stage);
    const slip = $(".f-slip", stage);
    const pause = $(".film-pause", stage);
    const screens = $$("[data-screen]", stage);
    const written = new Map(screens.map((s) => [s.dataset.screen, s.innerHTML]));
    const capWritten = cap.innerHTML;
    const scr = (name) => screens.find((s) => s.dataset.screen === name);
    const reset = (name) => { const s = scr(name); s.innerHTML = written.get(name); return s; };
    const phone = matchMedia("(max-width: 620px)");
    const rs = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const again = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };

    const show = (name) => {
      for (const s of screens) s.classList.toggle("is-on", s.dataset.screen === name);
      for (const t of $$(".t-tab", stage)) t.classList.toggle("is-on", (t.dataset.of || "").split(" ").includes(name));
    };
    // on a phone half the tablet shows: it slides to the half where things happen
    const look = (to) => {
      if (!phone.matches) { stage.removeAttribute("data-look"); return; }
      let side = to;
      if (typeof to !== "string") {
        const b = body.getBoundingClientRect(), r = to.getBoundingClientRect();
        side = (r.left + r.width / 2 - b.left) / b.width > 0.52 ? "right" : "left";
      }
      stage.dataset.look = side;
    };
    const lay = (html, where) => { sheet.innerHTML = html; sheet.classList.toggle("left", where === "left"); sheet.classList.add("is-up"); look(where === "left" ? "left" : "right"); };
    const print = (html) => { $(".paper", slip).innerHTML = html; slip.classList.add("is-out"); look("right"); };
    const clear = () => {
      sheet.classList.remove("is-up");
      slip.classList.remove("is-out");
      hand.classList.remove("is-on", "is-down");
      // a run stopped between two lines must not leave the line faded out
      cap.classList.remove("is-turning");
    };

    // a run of the film stops at its next wait once another has begun
    let turn = 0;
    const STOP = {};
    const player = (mine) => {
      const wait = (ms) => new Promise((ok) => setTimeout(ok, ms)).then(() => { if (mine !== turn) throw STOP; });
      return {
        wait,
        say: async (words) => {
          cap.classList.add("is-turning");
          await wait(200);
          cap.textContent = words;
          cap.classList.remove("is-turning");
        },
        tap: async (el, after = 280) => {
          look(el);
          const b = body.getBoundingClientRect(), r = el.getBoundingClientRect();
          hand.style.left = ((r.left + r.width / 2 - b.left) / b.width) * 100 + "%";
          hand.style.top = ((r.top + r.height / 2 - b.top) / b.height) * 100 + "%";
          hand.classList.add("is-on");
          await wait(660);
          hand.classList.add("is-down");
          again(el, "is-tapped");
          await wait(170);
          hand.classList.remove("is-down");
          await wait(after);
        },
      };
    };

    // ---- what both tills share: a payment in cash, and the paper ----

    const paySheet = (who, due, given) => `
      <p class="v-kicker">${who}</p><p class="v-due">Rs ${rs(due)}</p>
      <div class="v-types"><span class="is-on">Cash</span><span>Card</span><span>Transfer</span></div>
      <div class="f-given"><span>Exact</span>${given.map((g) => `<span data-given="${g}">${g.toLocaleString("en-US")}</span>`).join("")}</div>
      <p class="f-change"><span>Change</span><b>Rs 0.00</b></p>
      <div class="v-charge">Charge Rs ${rs(due)}</div>`;
    const takeCash = async (f, who, due, given, gave) => {
      lay(paySheet(who, due, given));
      await f.wait(650);
      const key = $(`[data-given="${gave}"]`, sheet);
      await f.tap(key, 120);
      key.classList.add("is-on");
      const change = $(".f-change", sheet);
      $("b", change).textContent = "Rs " + rs(gave - due);
      change.classList.add("is-in");
      await f.say("The change to give is worked out.");
      await f.wait(500);
      const charge = $(".v-charge", sheet);
      await f.tap(charge, 100);
      charge.classList.add("is-paid");
      charge.textContent = "Paid · change Rs " + rs(gave - due);
    };
    const row = (a, b, cls = "") => `<p class="p-row${cls}"><span>${a}</span><span>${b}</span></p>`;

    // ---- a restaurant: table 2 ----

    const DISHES = { "Mine frite poulet": 220, "Briani poulet": 290, "Cari poulet": 280 };
    const ORDER = [["Mine frite poulet", 2], ["Briani poulet", 1], ["Cari poulet", 1]];
    const tile = (s, name) => $$(".t-item", s).find((t) => $("b", t).textContent === name);
    const lineOf = (s, name) => $$(".t-line", s).find((l) => l.dataset.name === name);

    // the order screen as table 2's, holding these dishes
    const table2 = (dishes, sentAt) => {
      const o = reset("order");
      $(".t-ticket header b", o).textContent = "Table 2";
      const box = $(".t-lines", o);
      box.innerHTML = dishes.length ? "" : `<p class="t-empty">Tap a dish to start the order</p>`;
      for (const [name, qty] of dishes) dish(o, name, qty, false);
      if (sentAt) sent(o, sentAt);
      return o;
    };
    const bill = (o) => {
      const sub = $$(".t-line", o).reduce((n, l) => n + Number(l.dataset.qty) * DISHES[l.dataset.name], 0);
      const out = $$(".t-sum span:last-child", o);
      out[0].textContent = rs(sub);
      out[1].textContent = rs(sub * 0.1);
      out[2].textContent = "Rs " + rs(sub * 1.1);
      return sub * 1.1;
    };
    // one more of a dish on the order: a new line, or one more on its line
    const dish = (o, name, qty = 1, lively = true) => {
      const box = $(".t-lines", o);
      const empty = $(".t-empty", box);
      if (empty) box.innerHTML = `<p class="t-group new">New</p>`;
      else if (!$(".t-group", box)) box.insertAdjacentHTML("afterbegin", `<p class="t-group new">New</p>`);
      let line = lineOf(o, name);
      if (!line) {
        box.insertAdjacentHTML("beforeend", `<div class="t-line${lively ? " is-new" : ""}" data-name="${name}" data-qty="0"><span class="q"></span><span class="n">${name}</span><span class="p"></span></div>`);
        line = box.lastElementChild;
      } else if (lively) again($(".q", line), "is-bump");
      line.dataset.qty = Number(line.dataset.qty) + qty;
      $(".q", line).textContent = line.dataset.qty;
      $(".p", line).textContent = rs(line.dataset.qty * DISHES[name]);
      bill(o);
      if (lively) again($(".t-sum.total span:last-child", o), "is-bump");
    };
    const sent = (o, at) => {
      const group = $(".t-group", o);
      group.className = "t-group";
      group.textContent = "Sent to the kitchen · " + at;
      for (const l of $$(".t-line", o)) l.classList.add("sent");
    };

    // ---- a shop: one sale ----

    const GOODS = {
      "Polo shirt": { price: 890, had: 12, variant: "M · Navy" },
      "Canvas tote": { price: 450, had: 5 },
      "Notebook A5": { price: 150, had: 3 },
    };
    const SALE = [["Polo shirt", 1], ["Canvas tote", 1], ["Notebook A5", 2]];
    // the sell screen holding these products, with this much off the sale
    const sale = (goods, off = 0) => {
      const s = reset("sell");
      $(".t-lines", s).innerHTML = goods.length ? "" : `<p class="t-empty">Scan a product to start</p>`;
      for (const name of Object.keys(GOODS)) left(s, name, 0);
      for (const [name, qty] of goods) ring(s, name, qty, false);
      discount(s, off, false);
      return s;
    };
    // what a tile says is left of its product, once this many are on the sale
    const left = (s, name, sold, lively) => {
      const badge = $(".t-left", tile(s, name));
      const n = GOODS[name].had - sold;
      badge.textContent = n > 0 ? n + " left" : "Out";
      badge.classList.toggle("few", n > 0 && n <= 5);
      badge.classList.toggle("none", n <= 0);
      if (lively) again(badge, "is-bump");
    };
    const total = (s) => {
      const sub = $$(".t-line", s).reduce((n, l) => n + Number(l.dataset.qty) * GOODS[l.dataset.name].price, 0);
      const off = Number(s.dataset.off || 0);
      const out = $$(".t-sum span:last-child", s);
      out[0].textContent = rs(sub);
      out[1].textContent = "−" + rs((sub * off) / 100);
      out[2].textContent = "Rs " + rs(sub * (1 - off / 100));
      $(".pay", s).textContent = sub ? "Pay Rs " + rs(sub * (1 - off / 100)) : "Pay";
      return sub * (1 - off / 100);
    };
    // one more of a product on the sale: a new line, or one more on its line
    const ring = (s, name, qty = 1, lively = true) => {
      const box = $(".t-lines", s);
      const empty = $(".t-empty", box);
      if (empty) empty.remove();
      let line = lineOf(s, name);
      if (!line) {
        const v = GOODS[name].variant;
        box.insertAdjacentHTML("beforeend", `<div class="t-line${lively ? " is-new" : ""}" data-name="${name}" data-qty="0"><span class="q"></span><span class="n">${name}${v ? `<small>${v}</small>` : ""}</span><span class="p"></span></div>`);
        line = box.lastElementChild;
      } else if (lively) again($(".q", line), "is-bump");
      line.dataset.qty = Number(line.dataset.qty) + qty;
      $(".q", line).textContent = line.dataset.qty;
      $(".p", line).textContent = rs(line.dataset.qty * GOODS[name].price);
      left(s, name, Number(line.dataset.qty), lively);
      total(s);
      if (lively) again($(".t-sum.total span:last-child", s), "is-bump");
    };
    const discount = (s, off, lively = true) => {
      s.dataset.off = off;
      const key = $(".disc", s);
      key.textContent = off ? `Discount · ${off}% off` : "Discount on sale";
      key.classList.toggle("is-set", !!off);
      const line = $(".t-sum.off", s);
      line.hidden = !off;
      $("span", line).textContent = `Discount ${off}%`;
      total(s);
      if (lively) again($(".t-sum.total span:last-child", s), "is-bump");
    };
    // a scanner types a barcode into the box, and the till acts on it
    const scan = async (f, find, code) => {
      look(find);
      const box = $(".t-search", find), idle = box.textContent;
      find.classList.add("is-scan");
      box.textContent = code;
      await f.wait(560);
      find.classList.remove("is-scan");
      box.textContent = idle;
    };

    // ---- the chapters ----

    const CHAPTERS = {
      seat: { ms: 5200, screen: "floor", play: async (f) => {
        const floor = reset("floor");
        show("floor");
        await f.say("A party of three walks in. Tap a free table.");
        await f.wait(500);
        const t2 = $$(".t-plan .tb", floor).find((t) => $("b", t).textContent === "2");
        await f.tap(t2);
        t2.classList.replace("free", "seated");
        t2.innerHTML = "<b>2</b><i>3 covers</i><u>Just seated</u>";
        $(".t-areas .is-on b", floor).textContent = "6/11";
        await f.wait(1100);
      } },
      order: { ms: 9600, screen: "order", play: async (f) => {
        const o = table2([]);
        show("order");
        await f.say("Tap what they ask for. The bill adds itself up.");
        for (const [name, qty] of ORDER) {
          for (let n = 0; n < qty; n++) { await f.tap(tile(o, name), 160); dish(o, name); look("left"); await f.wait(380); }
        }
        await f.wait(500);
      } },
      kitchen: { ms: 11200, screen: "kitchen", play: async (f) => {
        const o = table2(ORDER);
        show("order");
        await f.say("One tap sends it. Each dish prints where it is made.");
        await f.wait(300);
        await f.tap($(".send", o), 120);
        sent(o, "19:42");
        print(`<p class="p-head">KITCHEN</p>${row("Table 2", "3 covers")}${row("19:42", "Priya")}<hr>
          <p class="p-item"><b>2</b>Mine frite poulet</p><p class="p-item"><b>1</b>Briani poulet</p><p class="p-item"><b>1</b>Cari poulet</p><hr>`);
        await f.wait(2300);
        clear();
        const k = reset("kitchen");
        $(".t-tickets", k).insertAdjacentHTML("afterbegin", `<article class="t-tk is-fresh">
          <header><b>Table 2</b><span>3 covers · Priya</span><em>00:04</em></header>
          <ul><li><i>2</i><span>Mine frite poulet</span></li><li><i>1</i><span>Briani poulet</span></li><li><i>1</i><span>Cari poulet</span></li></ul>
          <footer>Bump</footer></article>`);
        show("kitchen");
        look("left");
        await f.say("The kitchen screen has it too, with a clock on every ticket.");
        const fresh = $(".t-tk.is-fresh", k), clock = $("header em", fresh);
        for (let s = 5; s <= 8; s++) { await f.wait(700); clock.textContent = "00:0" + s; }
        const first = $("li", fresh);
        await f.tap(first, 100);
        first.classList.add("done");
        await f.wait(900);
      } },
      pay: { ms: 12400, screen: "order", play: async (f) => {
        const o = table2(ORDER, "19:42");
        show("order");
        await f.say("They ask for the bill. Cash, card, or split between them.");
        await f.wait(400);
        await f.tap($(".pay", o), 100);
        await takeCash(f, "Table 2 · 3 covers", 1111, [1200, 1500, 2000], 1200);
        print(`<p class="p-head">YOUR RESTAURANT</p><hr>${row("Table 2", "20:31")}<hr>
          ${row("2 Mine frite poulet", "440.00")}${row("1 Briani poulet", "290.00")}${row("1 Cari poulet", "280.00")}<hr>
          ${row("Service charge 10%", "101.00")}${row("TOTAL", "Rs 1,111.00", " p-total")}${row("Cash", "1,200.00")}${row("Change", "89.00")}<p class="p-foot">Thank you</p>`);
        await f.say("The receipt prints, and the table is free for the next party.");
        await f.wait(2600);
        clear();
        reset("floor");
        show("floor");
        look("left");
        await f.wait(1100);
      } },
      takeaway: { ms: 6400, screen: "board", play: async (f) => {
        const b = reset("board");
        show("board");
        await f.say("Takeaway and delivery wait on their own board, each with the time it is due.");
        await f.wait(900);
        const cols = $$(".t-col", b), card = $(".t-card", cols[0]);
        await f.tap(card, 120);
        $(".t-card", cols[1]).before(card);
        again(card, "is-moved");
        $("h6 b", cols[0]).textContent = "2";
        $("h6 b", cols[1]).textContent = "3";
        await f.wait(1500);
      } },

      scan: { ms: 10400, screen: "sell", play: async (f) => {
        const s = sale([]);
        show("sell");
        await f.say("Scan a barcode, or tap a tile. The sale builds itself.");
        await f.wait(500);
        const find = $(".t-find", s);
        for (const [name, code] of [["Polo shirt", "6 009 880 124 573"], ["Canvas tote", "6 009 880 204 182"]]) {
          await scan(f, find, code);
          ring(s, name);
          look("left");
          await f.wait(900);
        }
        await f.say("Every tile says what is left of its product.");
        for (let n = 0; n < 2; n++) { await f.tap(tile(s, "Notebook A5"), 420); ring(s, "Notebook A5"); }
        look("left");
        await f.wait(900);
      } },
      discount: { ms: 7400, screen: "sell", play: async (f) => {
        const s = sale(SALE);
        show("sell");
        await f.say("A discount on the whole sale, or on a single line.");
        await f.wait(400);
        await f.tap($(".disc", s), 100);
        lay(`<p class="v-kicker">Discount on sale</p><div class="f-pick"><span>10% off</span><span>20% off</span><span>Another percentage</span><span>Rupees off</span></div>`, "left");
        await f.wait(650);
        const ten = $(".f-pick span", sheet);
        await f.tap(ten, 100);
        ten.classList.add("is-on");
        await f.wait(350);
        clear();
        discount(s, 10);
        await f.say("It comes off every line in proportion, and the total follows.");
        await f.wait(1500);
      } },
      charge: { ms: 12000, screen: "sell", play: async (f) => {
        const s = sale(SALE, 10);
        show("sell");
        await f.say("Cash: tap what the customer gave.");
        await f.wait(400);
        await f.tap($(".pay", s), 100);
        await takeCash(f, "Sale · 4 items", 1476, [1500, 2000, 5000], 2000);
        print(`<p class="p-head">YOUR SHOP</p><hr>${row("Receipt 000214", "15:42")}<hr>
          ${row("1 Polo shirt M Navy", "890.00")}${row("1 Canvas tote", "450.00")}${row("2 Notebook A5", "300.00")}<hr>
          ${row("Discount 10%", "-164.00")}${row("TOTAL", "Rs 1,476.00", " p-total")}${row("Cash", "2,000.00")}${row("Change", "524.00")}
          <div class="p-bars"></div><p class="p-code">000214</p>`);
        await f.say("The receipt prints with a barcode at its foot.");
        await f.wait(2700);
        clear();
        sale([]);
        look("left");
        await f.wait(700);
      } },
      "return": { ms: 12600, screen: "receipts", play: async (f) => {
        const r = reset("receipts");
        const open = $(".t-ropen", r), whole = open.innerHTML;
        const first = $(".t-rlist li", r);
        first.classList.remove("is-on");
        open.innerHTML = `<p class="t-wait">Scan the barcode at the foot of a receipt, or tap one in the list.</p>`;
        show("receipts");
        look("left");
        await f.say("A customer is back with the shirt. Scan the receipt and it opens.");
        await f.wait(800);
        await scan(f, $(".t-find", r), "000214");
        first.classList.add("is-on");
        open.innerHTML = whole;
        look("right");
        await f.wait(1000);
        await f.tap($(".refund", open), 100);
        $("footer", open).outerHTML = `<div class="t-refund"><p><b>Refund Rs 1,476.00</b><span>Cash · put back into stock</span></p><span class="go">Refund</span></div>`;
        await f.say("Take off what the customer keeps.");
        const lines = $$(".t-rlines .t-line", open), sum = $(".t-refund b", open);
        for (const [i, amount] of [[1, "1,071.00"], [2, "801.00"]]) {
          await f.tap(lines[i], 100);
          lines[i].classList.add("kept");
          sum.textContent = "Refund Rs " + amount;
          again(sum, "is-bump");
        }
        await f.wait(300);
        await f.tap($(".go", open), 100);
        const chip = $(".t-chip", open);
        chip.textContent = "Refunded Rs 801.00";
        chip.classList.add("back");
        $(".t-refund", open).innerHTML = `<p><b>Rs 801.00 given back</b><span>The polo shirt is back in stock</span></p>`;
        await f.say("The money goes back, and the shirt goes back into stock.");
        await f.wait(1700);
      } },
    };
    const FILMS = { restaurant: ["seat", "order", "kitchen", "pay", "takeaway"], shop: ["scan", "discount", "charge", "return"] };

    // ---- the player ----

    let at = 0, paused = false, inView = false;
    const bars = $$(".switch", stage);
    const light = (name) => {
      for (const k of $$(".switch button", stage)) {
        const on = k.dataset.chapter === name;
        k.classList.toggle("is-on", on);
        k.setAttribute("aria-pressed", String(on));
      }
    };
    // the lit key fills up over the length of its chapter
    const fill = (ms) => {
      for (const b of bars) {
        b.classList.remove("is-auto");
        if (!ms) continue;
        b.style.setProperty("--turn", ms + "ms");
        void b.offsetWidth;
        b.classList.add("is-auto");
      }
    };
    const play = async () => {
      const mine = ++turn;
      clear();
      fill(0);
      const names = FILMS[whose()];
      at %= names.length;
      light(names[at]);
      if (still) { show(CHAPTERS[names[at]].screen); return; }
      if (paused || !inView || document.hidden) return;
      const f = player(mine);
      try {
        for (;;) {
          const chapter = CHAPTERS[names[at]];
          light(names[at]);
          fill(chapter.ms);
          const began = performance.now();
          await chapter.play(f);
          await f.wait(Math.max(400, chapter.ms - (performance.now() - began)));
          clear();
          at = (at + 1) % names.length;
        }
      } catch (e) {
        if (e !== STOP) throw e;
      }
    };
    const setPaused = (on) => {
      paused = on;
      pause.setAttribute("aria-pressed", String(on));
      $("use", pause).setAttribute("href", on ? "#i-play" : "#i-pause");
      $("span", pause).textContent = on ? "Play" : "Pause";
    };

    for (const k of $$(".switch button", stage)) {
      k.addEventListener("click", () => {
        const i = FILMS[whose()].indexOf(k.dataset.chapter);
        if (i < 0) return; // a key of the other till's film
        at = i;
        setPaused(false);
        play();
      });
    }
    pause.addEventListener("click", () => { setPaused(!paused); play(); });
    pause.hidden = still;
    // the other kind of business: its film from the start, and the line as written until it speaks
    picked.push(() => { at = 0; cap.innerHTML = capWritten; for (const s of screens) reset(s.dataset.screen); show(whose() === "shop" ? "sell" : "floor"); play(); });
    document.addEventListener("visibilitychange", play);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([e]) => { inView = e.isIntersecting; play(); }, { threshold: 0.3 }).observe(stage);
    } else {
      inView = true;
      play();
    }
  })();

  // ---- smaller movement in the sections, only while each is on screen ----

  (() => {
    if (still || !("IntersectionObserver" in window)) return;
    // calls `step(n)` every `ms` while `el` is on screen, counting from 0 each time it comes back
    const live = (el, ms, step) => {
      if (!el) return;
      let timer = 0, n = 0;
      new IntersectionObserver(([e]) => {
        clearInterval(timer);
        el.classList.toggle("is-live", e.isIntersecting);
        if (e.isIntersecting) { n = 0; step(0); timer = setInterval(() => step(++n), ms); }
      }, { threshold: 0.35 }).observe(el);
    };
    const bump = (el) => { el.classList.remove("is-bump"); void el.offsetWidth; el.classList.add("is-bump"); };

    // the kitchen: the ticket's clock runs, and a line is ticked when it is done
    const tk = $(".v-kitchen .t-tk");
    if (tk) {
      const clock = $("header em", tk), lines = $$("li", tk);
      live(tk, 1000, (n) => {
        const s = 571 + (n % 8);
        clock.textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
        lines[1].classList.toggle("done", n % 8 >= 4);
      });
    }

    // a split bill: the last share is paid, and the bill is settled
    const box = $(".v-pay:not(.v-return) .v-paybox");
    if (box) {
      const last = $(".v-shares li:last-child", box), charge = $(".v-charge", box);
      const due = last.innerHTML, ask = charge.textContent;
      live(box, 2400, (n) => {
        const paid = n % 2 === 1;
        last.className = paid ? "paid" : "now";
        last.innerHTML = paid ? `<b>3</b><span>Card</span><em>612.34</em><svg class="ico"><use href="#i-check"/></svg>` : due;
        charge.textContent = paid ? "Paid in full" : ask;
      });
    }

    // a product with sizes: one is picked, and the key says which
    const sizes = $('[data-loop="size"]');
    if (sizes) {
      const chips = $$("span:not(.none)", sizes), says = $("[data-loop-says]");
      live(sizes, 1700, (n) => {
        const on = chips[(n + 1) % chips.length];
        for (const c of chips) c.classList.toggle("is-on", c === on);
        says.textContent = on.firstChild.textContent;
      });
    }

    // stock: every sale takes one, and the figure turns amber when few are left
    const count = $('[data-loop="stock"] [data-count]');
    if (count) {
      live(count.closest("ul"), 1300, (n) => {
        const left = 12 - (n % 10);
        count.textContent = left;
        count.parentNode.classList.toggle("few", left <= 5);
        if (n) bump(count);
      });
    }

    // the scanner's line over a receipt's barcode is the stylesheet's, while this is set
    live($(".v-return"), 60000, () => {});
  })();

  // ---- the demo form: writes the message, the visitor's own app sends it ----

  (() => {
    const form = $("[data-demo-form]");
    if (!form) return;
    const error = $(".form-error", form);
    const byWhatsApp = $('[data-via="whatsapp"]', form);
    const byEmail = $('[data-via="email"]', form);
    const hint = $("[data-hint]", form);
    if (digits) byWhatsApp.hidden = false;
    if (!cfg.email) byEmail.hidden = true;
    if (digits) hint.textContent = "This opens WhatsApp or your e-mail app with the message written. Nothing is sent until you press send there.";

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const via = (e.submitter && e.submitter.dataset.via) || (digits ? "whatsapp" : "email");
      const need = ["name", "business", "phone"].map((n) => form.elements[n]);
      const missing = need.filter((f) => !f.value.trim());
      for (const f of need) f.classList.toggle("is-missing", missing.includes(f));
      error.hidden = !missing.length;
      if (missing.length) { missing[0].focus(); return; }

      const v = (n) => form.elements[n].value.trim();
      // the message says which till to show: a restaurant's or a shop's
      const shop = whose() === "shop";
      const text = [
        `Hello EasyPay, I would like a demo for my ${shop ? "shop" : "restaurant"}.`,
        "",
        `Name: ${v("name")}`,
        `${shop ? "Shop" : "Restaurant"}: ${v("business")}`,
        `Phone: ${v("phone")}`,
        v("note") ? `Note: ${v("note")}` : "",
      ].filter((line, i) => line || i === 1).join("\n");

      location.href = via === "whatsapp" && digits
        ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
        : `mailto:${cfg.email}?subject=${encodeURIComponent("Demo for " + v("business"))}&body=${encodeURIComponent(text)}`;
    });
    form.addEventListener("input", (e) => e.target.classList.remove("is-missing"));
  })();

  // ---- the dots behind the page ----
  //
  // A grid of dots fixed to the page (it scrolls with it). A dot fades as it
  // nears anything marked data-solid, so the pattern lives in the margins and
  // the gaps between sections, in drifting patches rather than an even sheet.
  // Under the mouse the dots part, turn the logo's green, and spring back.
  //
  // One canvas, a little taller than the window, sits in the page and is
  // moved only when the window nears its edge: between moves the browser
  // scrolls it like any other element, so the dots never swim against the
  // text. The resting pattern is painted once into a buffer; a frame only
  // repaints the patch around the mouse.

  (() => {
    const cv = $(".dots");
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext("2d");
    const buf = document.createElement("canvas");
    const bctx = buf.getContext("2d");

    const GAP = 22;        // between dots
    const R = 1.15;        // a dot's radius
    const OVER = 440;      // how far the canvas reaches above and below the window
    const NEAR = 16;       // closer to a solid thing than this: no dot
    const FAR = 150;       // further than this: the dot at full strength
    const INK = 0.34;      // a resting dot's strength at most
    const LEVELS = 12;     // strengths the resting pattern is painted in
    const REACH = 150;     // how far the mouse is felt
    const PUSH = 14;       // how far it moves a dot
    const INK_RGB = [23, 32, 26], LEAF_RGB = [63, 132, 67];

    let dpr = 1, W = 0, H = 0, top = 0, docH = 0, cols = 0, rows = 0, row0 = 0, xoff = 0;
    let base = new Float32Array(0);
    let solids = [];
    const live = new Map(); // dots the mouse has moved: page row * 4096 + column -> state
    let px = 0, pcy = 0, hasMouse = false, raf = 0, lastBox = null;
    const STEP = 1000 / 60;
    let lastTime = 0, owed = 0;

    const hash = (x, y) => {
      let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
    };
    const ease = (a, b, t) => { t = Math.min(1, Math.max(0, (t - a) / (b - a))); return t * t * (3 - 2 * t); };
    // smooth noise, for the patches
    const cloud = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };

    // where the solid things are, in page coordinates
    function measure() {
      const sy = scrollY;
      solids = [];
      for (const el of $$("[data-solid]")) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) solids.push([r.left, r.top + sy, r.right, r.bottom + sy, FAR]);
      }
      // the bar is fixed, so it only meets the dots at the top of the page
      const bar = $(".nav").getBoundingClientRect();
      solids.push([bar.left, 0, bar.right, bar.bottom + 6, 80]);
      docH = Math.max(document.documentElement.scrollHeight, innerHeight);
    }

    function resize() {
      dpr = Math.min(devicePixelRatio || 1, 2);
      const w = document.documentElement.clientWidth;
      const h = Math.ceil(Math.min(innerHeight + OVER * 2, docH) / GAP) * GAP;
      if (w !== W || h !== H || cv.width !== Math.round(w * dpr)) {
        W = w; H = h;
        for (const c of [cv, buf]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
        cv.style.width = W + "px"; cv.style.height = H + "px";
        cols = Math.floor(W / GAP); rows = H / GAP;
        xoff = (W - cols * GAP) / 2;
        base = new Float32Array(cols * rows);
      }
    }

    // put the canvas around the window and paint the resting pattern
    function place(force) {
      const max = Math.max(0, Math.floor((docH - H) / GAP) * GAP);
      const t = Math.min(max, Math.max(0, Math.floor((scrollY - OVER) / GAP) * GAP));
      if (!force && t === top) return;
      top = t; row0 = top / GAP;
      cv.style.transform = `translate3d(0,${top}px,0)`;
      rest();
      lastBox = null;
      paint(0, 0, W, H);
      if (live.size) kick();
    }

    function rest() {
      const near = solids.filter((s) => s[3] > top - FAR && s[1] < top + H + FAR);
      const paths = Array.from({ length: LEVELS }, () => new Path2D());
      for (let r = 0; r < rows; r++) {
        const ly = r * GAP + GAP / 2, y = top + ly;
        const band = near.filter((s) => s[3] > y - FAR && s[1] < y + FAR);
        for (let c = 0; c < cols; c++) {
          const x = xoff + c * GAP + GAP / 2;
          let m = 1;
          for (let i = 0; i < band.length && m > 0; i++) {
            const s = band[i];
            const dx = x < s[0] ? s[0] - x : x > s[2] ? x - s[2] : 0;
            const dy = y < s[1] ? s[1] - y : y > s[3] ? y - s[3] : 0;
            const d = dx && dy ? Math.hypot(dx, dy) : dx + dy;
            if (d < s[4]) m = Math.min(m, ease(NEAR, s[4], d));
          }
          let level = 0;
          if (m > 0) {
            m *= 0.16 + 0.84 * ease(0.3, 0.7, cloud(x * 0.0023 + 11.7, y * 0.0023 + 3.1));
            level = Math.round(m * LEVELS);
          }
          base[r * cols + c] = (level / LEVELS) * INK;
          if (level) { const p = paths[level - 1]; p.moveTo(x + R, ly); p.arc(x, ly, R, 0, 6.2832); }
        }
      }
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.clearRect(0, 0, W, H);
      bctx.fillStyle = `rgb(${INK_RGB})`;
      paths.forEach((p, i) => { bctx.globalAlpha = ((i + 1) / LEVELS) * INK; bctx.fill(p); });
      bctx.globalAlpha = 1;
    }

    // copy a patch of the resting pattern to the screen
    function paint(x0, y0, x1, y1) {
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
      x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
      if (x1 <= x0 || y1 <= y0) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const sx = Math.round(x0 * dpr), sy = Math.round(y0 * dpr), sw = Math.round((x1 - x0) * dpr), sh = Math.round((y1 - y0) * dpr);
      ctx.clearRect(sx, sy, sw, sh);
      ctx.drawImage(buf, sx, sy, sw, sh, sx, sy, sw, sh);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function frame(now) {
      raf = 0;
      // the springs move sixty times a second whatever the screen's own rate
      owed = Math.min(owed + (lastTime ? now - lastTime : STEP), STEP * 4);
      lastTime = now;
      let steps = 0;
      while (owed >= STEP) { owed -= STEP; steps++; }
      const mx = px, my = pcy + scrollY - top; // the mouse, on the canvas
      if (hasMouse) {
        const c0 = Math.max(0, Math.floor((mx - REACH - xoff) / GAP)), c1 = Math.min(cols - 1, Math.ceil((mx + REACH - xoff) / GAP));
        const r0 = Math.max(0, Math.floor((my - REACH) / GAP)), r1 = Math.min(rows - 1, Math.ceil((my + REACH) / GAP));
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          if (!base[r * cols + c]) continue;
          const key = (row0 + r) * 4096 + c;
          if (!live.has(key)) live.set(key, { ox: 0, oy: 0, vx: 0, vy: 0, f: 0 });
        }
      }

      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      const drawn = [];
      for (const [key, s] of live) {
        const c = key % 4096, r = Math.floor(key / 4096) - row0;
        const a = r >= 0 && r < rows && c < cols ? base[r * cols + c] : 0;
        if (!a) { live.delete(key); continue; }
        const x = xoff + c * GAP + GAP / 2, y = r * GAP + GAP / 2;
        let tx = 0, ty = 0, tf = 0;
        if (hasMouse) {
          const dx = x - mx, dy = y - my, d = Math.hypot(dx, dy);
          if (d < REACH) {
            const k = 1 - d / REACH;
            tf = k * k;
            if (d > 0.01) { tx = (dx / d) * tf * PUSH; ty = (dy / d) * tf * PUSH; }
          }
        }
        // a spring back to where the dot belongs, or to where the mouse pushes it
        for (let n = 0; n < steps; n++) {
          s.vx = (s.vx + (tx - s.ox) * 0.12) * 0.72;
          s.vy = (s.vy + (ty - s.oy) * 0.12) * 0.72;
          s.ox += s.vx; s.oy += s.vy;
          s.f += (tf - s.f) * 0.15;
        }
        bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
        const settled = !tf && s.f < 0.01 && Math.abs(s.ox) + Math.abs(s.oy) + Math.abs(s.vx) + Math.abs(s.vy) < 0.08;
        if (settled) live.delete(key); else drawn.push(x, y, a, s);
      }

      // repaint the patch that held moved dots last frame and holds them now
      const pad = PUSH + 6;
      const box = bx0 <= bx1 ? [bx0 - pad, by0 - pad, bx1 + pad, by1 + pad] : null;
      const b = box && lastBox
        ? [Math.min(box[0], lastBox[0]), Math.min(box[1], lastBox[1]), Math.max(box[2], lastBox[2]), Math.max(box[3], lastBox[3])]
        : box || lastBox;
      if (b) paint(b[0], b[1], b[2], b[3]);
      lastBox = drawn.length ? box : null;

      for (let i = 0; i < drawn.length; i += 4) {
        const x = drawn[i], y = drawn[i + 1], a = drawn[i + 2], s = drawn[i + 3];
        ctx.clearRect(x - R - 1, y - R - 1, R * 2 + 2, R * 2 + 2); // the resting dot
        const f = s.f;
        ctx.globalAlpha = Math.min(0.95, a * (1 + 2.4 * f) + 0.12 * f);
        ctx.fillStyle = `rgb(${INK_RGB.map((v, j) => Math.round(v + (LEAF_RGB[j] - v) * Math.min(1, f * 1.6)))})`;
        ctx.beginPath();
        ctx.arc(x + s.ox, y + s.oy, R * (1 + 0.8 * f), 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (live.size) raf = requestAnimationFrame(frame); else lastTime = 0;
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

    const refresh = () => { measure(); resize(); place(true); };
    let soonId = 0;
    const soon = () => { clearTimeout(soonId); soonId = setTimeout(refresh, 140); };

    addEventListener("scroll", () => {
      const sy = scrollY;
      if ((sy < top + 140 && top > 0) || (sy + innerHeight > top + H - 140 && top + H < docH)) place(false);
      if (hasMouse) kick();
    }, { passive: true });
    addEventListener("resize", soon);
    addEventListener("load", soon);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(soon);
    if ("ResizeObserver" in window) new ResizeObserver(soon).observe(document.body);
    // a piece that has finished arriving has moved a little: measure again
    document.addEventListener("transitionend", (e) => { if (e.target.hasAttribute && e.target.hasAttribute("data-reveal")) soon(); });

    if (mouse && !still) {
      addEventListener("pointermove", (e) => {
        if (e.pointerType === "touch") return;
        px = e.clientX; pcy = e.clientY; hasMouse = true; kick();
      }, { passive: true });
      document.documentElement.addEventListener("pointerleave", () => { hasMouse = false; kick(); });
      addEventListener("blur", () => { hasMouse = false; kick(); });
    }

    refresh();
  })();
})();
