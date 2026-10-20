// The pieces of the page a visitor can press. Each does what the product
// does, and nothing it does not: a tab shows another page of the back office
// as it is; a sale rung up with the router unplugged is kept on the tablet
// and sent when the line is back; a table is seated, asked for its bill and
// paid; a kitchen ticket's lines are ticked, and the ticket bumped and
// recalled; a bill is split equally between the guests picked and each share
// charged its own way; a guest orders from the phone, the till accepts or
// declines, and the phone is told. The figures and names in them are made up.
(() => {
  "use strict";
  const $ = (q, el = document) => el.querySelector(q);
  const $$ = (q, el = document) => [...el.querySelectorAll(q)];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.documentElement;
  const shop = () => root.dataset.for === "shop";
  const two = (n) => String(n).padStart(2, "0");
  const money = (cents) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // runs `on(true)` while `el` is on the screen and `on(false)` when it leaves
  const seen = (el, on) => {
    if (!("IntersectionObserver" in window)) return on(true);
    new IntersectionObserver(([e]) => on(e.isIntersecting), { threshold: 0.3 }).observe(el);
  };

  // ---- the back office's pages: a tab shows its picture and says what the page is for ----

  for (const tour of $$("[data-tour]")) {
    const tabs = $$('[role="tab"]', tour), img = $("[data-tour-img]", tour), says = $("[data-tour-says]", tour);
    const src = (name, big) => `assets/shots/${name}${big ? "" : "-1000"}.webp`;
    const show = (tab) => {
      for (const t of tabs) { t.setAttribute("aria-selected", String(t === tab)); t.tabIndex = t === tab ? 0 : -1; }
      const name = tab.dataset.shot;
      // the picture that is there stays, dimmed, until the next one has come
      const next = new Image();
      img.classList.add("is-turning");
      next.onload = next.onerror = () => {
        img.srcset = `${src(name, false)} 1000w, ${src(name, true)} 2000w`;
        img.src = src(name, false);
        img.alt = tab.dataset.alt;
        img.classList.remove("is-turning");
      };
      next.srcset = `${src(name, false)} 1000w, ${src(name, true)} 2000w`;
      next.sizes = img.sizes;
      next.src = src(name, false);
      says.textContent = tab.dataset.says;
    };
    tabs.forEach((tab, i) => {
      tab.tabIndex = i === 0 ? 0 : -1;
      tab.addEventListener("click", () => show(tab));
      tab.addEventListener("keydown", (e) => {
        const to = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
        if (to) { e.preventDefault(); to.focus(); show(to); }
      });
    });
    // the keys either side of the picture: the page before, the next page, round and round
    const step = (by) => {
      const at = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
      show(tabs[(at + by + tabs.length) % tabs.length]);
    };
    const prev = $("[data-tour-prev]", tour), next = $("[data-tour-next]", tour);
    if (prev) prev.addEventListener("click", () => step(-1));
    if (next) next.addEventListener("click", () => step(1));
  }

  // ---- when the line drops: sales are kept on the tablet, and sent when it is back ----

  const log = $('[data-play="line"]');
  if (log) {
    const rows = $("[data-rows]", log), plug = $("[data-line]", log), sale = $("[data-sale]", log);
    const start = rows.innerHTML;
    const SALES = {
      restaurant: [["Table 2", 1260], ["A-13 · Takeaway", 480], ["Table 9", 3120], ["C-43 · Counter", 220], ["Table 5", 1575]],
      shop: [["Receipt 000217", 890], ["Receipt 000218", 2450], ["Receipt 000219", 350], ["Receipt 000220", 1290], ["Receipt 000221", 640]],
    };
    let online, minute, n, waiting;
    const reset = () => {
      rows.innerHTML = start; online = true; minute = 20 * 60 + 14; n = 0; waiting = [];
      plug.setAttribute("aria-pressed", "false"); $("span", plug).textContent = "Unplug the router";
    };
    const clock = () => { minute += 2 + (n % 3); return `${two(Math.floor(minute / 60) % 24)}:${two(minute % 60)}`; };
    const add = (html, cls) => {
      const p = document.createElement("p");
      if (cls) p.className = cls;
      p.classList.add("is-new");
      p.innerHTML = html;
      rows.append(p);
      // the log keeps to the height it had: the oldest lines of this kind of business go first
      const mine = $$("p", rows).filter((r) => !r.dataset.only || r.dataset.only === (shop() ? "shop" : "restaurant"));
      for (const old of mine.slice(0, Math.max(0, mine.length - 5))) old.remove();
      return p;
    };
    sale.addEventListener("click", () => {
      const list = SALES[shop() ? "shop" : "restaurant"], [what, rs] = list[n % list.length];
      const how = n % 2 ? "Card" : "Cash";
      n += 1;
      const p = add(`<time>${clock()}</time><span><b>${what}</b>Rs ${rs.toLocaleString("en-US")} · ${how}</span><em${online ? ' class="sent"' : ""}>${online ? "Sent" : "Kept on the tablet"}</em>`);
      if (!online) waiting.push(p);
    });
    plug.addEventListener("click", () => {
      online = !online;
      plug.setAttribute("aria-pressed", String(!online));
      $("span", plug).textContent = online ? "Unplug the router" : "Plug it back in";
      if (!online) { add(`<time>${clock()}</time><span><b>Connection lost</b></span>`, "lost"); return; }
      for (const p of waiting) { const em = $("em", p); if (em) { em.className = "sent"; em.textContent = "Sent"; } }
      const k = waiting.length;
      waiting = [];
      add(`<time>${clock()}</time><span><b>Connection back</b></span><em>${k === 0 ? "Nothing was waiting" : k === 1 ? "1 sale sent" : k + " sales sent"}</em>`, "back");
    });
    reset();
    // a restaurant's log is not a shop's: it starts again when the page changes hands
    new MutationObserver(reset).observe(root, { attributes: true, attributeFilter: ["data-for"] });
  }

  // ---- front of house: a table is seated, asked for its bill, paid ----

  const floor = $('[data-play="tables"]');
  if (floor) {
    const SAYS = {
      free: ["Free", "Tap it and say how many guests."],
      seated: ["Seated", "What it owes, and for how long. Tap when they ask for the bill."],
      bill: ["Waiting for the bill", "Printed, not yet paid. Tap when it is paid."],
      held: ["Reserved", "Held for the booking's time."],
    };
    const OWES = { 2: "Rs 1,260", 6: "Rs 2,980" };
    const strip = $(".v-booking", floor), who = $("[data-booking]", floor);
    const draw = (key, state, fresh) => {
      const no = key.dataset.n, tb = $(".tb", key), cap = key.parentNode.querySelector("figcaption");
      key.dataset.table = state;
      tb.className = "tb " + state;
      if (state === "free") tb.innerHTML = `<b>${no}</b><i>4 seats</i>`;
      if (state === "seated") tb.innerHTML = fresh ? `<b>${no}</b><i>${no === "6" ? "4 covers" : "2 covers"}</i><u>Just seated</u>` : `<b>${no}</b><i>${key.dataset.owes}</i><u>34 min</u>`;
      if (state === "bill") tb.innerHTML = `<b>${no}</b><i>${key.dataset.owes || OWES[no] || "Rs 1,260"}</i><u>Bill printed</u>`;
      cap.innerHTML = `<b>${SAYS[state][0]}</b>${SAYS[state][1]}`;
      key.setAttribute("aria-label", `Table ${no}: ${SAYS[state][0].toLowerCase()}. ${SAYS[state][1]}`);
    };
    const arrive = () => {
      const key = $('[data-n="6"]', floor);
      if (key.dataset.table !== "held") return;
      draw(key, "seated", true);
      strip.classList.add("is-seated");
      who.textContent = "Nadia · 4 guests · seated at table 6";
    };
    for (const key of $$("button.v-plot", floor)) {
      key.setAttribute("aria-label", `Table ${key.dataset.n}: ${SAYS[key.dataset.table][0].toLowerCase()}. ${SAYS[key.dataset.table][1]}`);
      key.addEventListener("click", () => {
        const at = key.dataset.table;
        if (at === "held") return arrive();
        draw(key, at === "free" ? "seated" : at === "seated" ? "bill" : "free", at === "free");
      });
    }
    $("[data-arrive]", floor).addEventListener("click", arrive);
  }

  // ---- the kitchen: a clock on the ticket, lines ticked, bump and recall ----

  const tk = $('[data-play="ticket"]');
  if (tk) {
    const clock = $("[data-clock]", tk), list = $("ul", tk), foot = $("footer", tk), gone = $(".tk-gone", tk);
    const [m, s] = clock.textContent.split(":").map(Number);
    let age = m * 60 + s, timer = 0, bumped = false;
    // amber after 8 minutes and red after 15: what a kitchen screen starts with
    const tone = () => { tk.classList.toggle("warm", !bumped && age >= 480 && age < 900); tk.classList.toggle("late", !bumped && age >= 900); };
    const tick = () => { age += 1; clock.textContent = `${two(Math.floor(age / 60))}:${two(age % 60)}`; tone(); };
    seen(tk, (on) => { clearInterval(timer); if (on && !still && !bumped) timer = setInterval(tick, 1000); });
    const press = (li) => { const done = li.classList.toggle("done"); li.setAttribute("aria-pressed", String(done)); };
    for (const li of $$('[role="button"]', list)) {
      li.addEventListener("click", () => press(li));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); press(li); } });
    }
    const put = (away) => {
      bumped = away;
      list.hidden = foot.hidden = away;
      gone.hidden = !away;
      tk.classList.toggle("is-gone", away);
      tone();
      clearInterval(timer);
      if (!away && !still) timer = setInterval(tick, 1000);
      (away ? $("[data-recall]", tk) : $("[data-bump]", tk)).focus({ preventScroll: true });
    };
    $("[data-bump]", tk).addEventListener("click", () => put(true));
    $("[data-recall]", tk).addEventListener("click", () => put(false));
    tone();
  }

  // ---- payment: equal shares for the guests picked, each charged its own way ----

  const box = $('[data-play="split"]');
  if (box) {
    const total = Number(box.dataset.total), shares = $("[data-shares]", box), count = $("[data-n]", box);
    const less = $("[data-less]", box), more = $("[data-more]", box), charge = $("[data-charge]", box);
    const types = $$(".v-types button", box), paper = $("[data-paid-rows]");
    // the page opens on a bill of three with two shares paid: the visitor charges the third
    let guests = 3, paid = ["Cash", "Card"];
    // equal shares, and the cents that do not divide go on the last one
    const share = (i) => { const each = Math.floor(total / guests); return i < guests - 1 ? each : total - each * (guests - 1); };
    const how = () => (types.find((t) => t.classList.contains("is-on")) || types[0]).textContent;
    const draw = (fresh) => {
      count.textContent = guests;
      less.disabled = guests <= 2; more.disabled = guests >= 6;
      shares.innerHTML = Array.from({ length: guests }, (_, i) =>
        i < paid.length ? `<li class="paid${fresh === i ? " is-new" : ""}"><b>${i + 1}</b><span>${paid[i]}</span><em>${money(share(i))}</em><svg class="ico"><use href="#i-check"/></svg></li>`
          : `<li${i === paid.length ? ' class="now"' : ""}><b>${i + 1}</b><span>To pay</span><em>${money(share(i))}</em></li>`).join("");
      const done = paid.length >= guests;
      charge.textContent = done ? "Paid in full · start again" : `Charge Rs ${money(share(paid.length))}`;
      charge.classList.toggle("is-done", done);
      if (paper) paper.innerHTML = paid.length ? paid.map((p, i) => `<p class="p-row"><span>${p}</span><span>${money(share(i))}</span></p>`).join("") : `<p class="p-row"><span>To pay</span><span>${money(total)}</span></p>`;
    };
    for (const t of types) t.addEventListener("click", () => { for (const x of types) { x.classList.toggle("is-on", x === t); x.setAttribute("aria-pressed", String(x === t)); } });
    less.addEventListener("click", () => { guests -= 1; paid = []; draw(); });
    more.addEventListener("click", () => { guests += 1; paid = []; draw(); });
    charge.addEventListener("click", () => {
      if (paid.length >= guests) { paid = []; return draw(); }
      paid.push(how());
      draw(paid.length - 1);
    });
    draw();
  }

  // ---- ordering from the table: the guest sends, the till accepts or declines, the phone is told ----

  const qr = $('[data-play="qr"]');
  if (qr) {
    const menu = $("[data-g-menu]", qr), state = $("[data-g-state]", qr), send = $("[data-send]", qr), again = $("[data-again]", qr);
    const title = $("[data-g-title]", qr), says = $("[data-g-says]", qr);
    const none = $("[data-none]", qr), order = $("[data-order]", qr), done = $("[data-done]", qr);
    const tiles = $$(".g-tile", qr), cart = new Map();
    const count = () => [...cart.values()].reduce((a, n) => a + n, 0);
    const sum = () => tiles.reduce((a, t) => a + (cart.get(t.dataset.dish) || 0) * Number(t.dataset.rs), 0);
    const drawMenu = () => {
      for (const t of tiles) {
        const n = cart.get(t.dataset.dish) || 0;
        t.classList.toggle("is-in", n > 0);
        $("em", t).textContent = n || "";
        t.setAttribute("aria-label", `${t.dataset.dish}, Rs ${t.dataset.rs}${n ? `, ${n} in the order` : ""}. Tap to add one.`);
      }
      const n = count();
      send.disabled = n === 0;
      send.textContent = n ? `Send order to staff · Rs ${sum().toLocaleString("en-US")}` : "Send order to staff";
    };
    const phone = (kind, head, line) => {
      menu.hidden = kind !== "menu"; state.hidden = kind === "menu";
      state.className = "g-state" + (kind === "wait" ? " is-wait" : kind === "yes" ? " is-yes" : kind === "no" ? " is-no" : "");
      title.textContent = head || ""; says.textContent = line || "";
      again.hidden = kind === "wait" || kind === "menu";
    };
    // a tile adds one of its dish; four of one is as many as the piece takes
    for (const t of tiles) t.addEventListener("click", () => { cart.set(t.dataset.dish, Math.min(4, (cart.get(t.dataset.dish) || 0) + 1)); drawMenu(); });
    send.addEventListener("click", () => {
      const n = count();
      phone("wait", "Order sent", "Waiting for staff to confirm");
      // on the till: the order, at the till's own names and prices
      $("[data-o-says]", qr).textContent = `${n} ${n === 1 ? "item" : "items"} · just now`;
      $("[data-o-total]", qr).textContent = `Rs ${sum().toLocaleString("en-US")}`;
      $("[data-o-lines]", qr).innerHTML = tiles.filter((t) => cart.get(t.dataset.dish)).map((t) => `<li><i>${cart.get(t.dataset.dish)}</i><span>${t.dataset.dish}</span><em>${(cart.get(t.dataset.dish) * Number(t.dataset.rs)).toLocaleString("en-US")}</em></li>`).join("");
      none.hidden = true; done.hidden = true; order.hidden = false;
      $("[data-accept]", qr).focus({ preventScroll: true });
    });
    const answer = (yes) => {
      order.hidden = true; done.hidden = false;
      done.classList.toggle("is-no", !yes);
      done.textContent = yes ? "Accepted. It is on table 4's order, to send to the kitchen as usual." : "Declined. The guest is asked to see a member of staff.";
      if (yes) phone("yes", "Confirmed", "Your order is with the staff. You pay at the table as usual.");
      else phone("no", "Not taken", "A member of staff could not take this order. Please ask them, or order again.");
    };
    $("[data-accept]", qr).addEventListener("click", () => answer(true));
    $("[data-decline]", qr).addEventListener("click", () => answer(false));
    again.addEventListener("click", () => { cart.clear(); drawMenu(); phone("menu"); none.hidden = false; done.hidden = true; });
    drawMenu();
  }
})();
