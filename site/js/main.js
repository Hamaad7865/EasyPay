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
  const direct = $("[data-direct]");
  if (direct && (cfg.email || digits)) {
    const bits = [];
    if (digits) bits.push(`<a href="https://wa.me/${digits}">WhatsApp +${digits}</a>`);
    if (cfg.email) bits.push(`<a href="mailto:${cfg.email}">${cfg.email}</a>`);
    direct.innerHTML = "Or write to us: " + bits.join(" · ");
    direct.hidden = false;
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

  // ---- the tablet: four screens of the till, turning on their own ----

  (() => {
    const stage = $(".stage--hero");
    if (!stage) return;
    const keys = $$(".switch button", stage);
    const bar = $(".switch", stage);
    const order = keys.map((k) => k.dataset.show);
    const TURN = 5500;
    let at = 0, timer = 0, auto = !still, inView = true;
    bar.style.setProperty("--turn", TURN + "ms");

    const show = (name) => {
      at = Math.max(0, order.indexOf(name));
      for (const s of $$("[data-screen]", stage)) s.classList.toggle("is-on", s.dataset.screen === name);
      for (const t of $$(".t-tab", stage)) t.classList.toggle("is-on", (t.dataset.for || "").split(" ").includes(name));
      for (const k of keys) {
        const on = k.dataset.show === name;
        k.classList.toggle("is-on", on);
        k.setAttribute("aria-pressed", String(on));
      }
    };
    const run = () => {
      clearTimeout(timer);
      const go = auto && inView && !document.hidden;
      bar.classList.toggle("is-auto", go);
      if (go) timer = setTimeout(() => { show(order[(at + 1) % order.length]); restart(); }, TURN);
    };
    // the lit key's bar starts again from empty
    const restart = () => { bar.classList.remove("is-auto"); void bar.offsetWidth; run(); };
    // once someone picks a screen, the tablet stops turning by itself
    const pick = (name) => { auto = false; show(name); run(); };

    for (const k of keys) k.addEventListener("click", () => pick(k.dataset.show));
    for (const el of $$("[data-go]", stage)) el.addEventListener("click", () => pick(el.dataset.go));
    document.addEventListener("visibilitychange", restart);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([e]) => { inView = e.isIntersecting; restart(); }, { threshold: 0.35 }).observe(stage);
    }
    run();
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
      const need = ["name", "restaurant", "phone"].map((n) => form.elements[n]);
      const missing = need.filter((f) => !f.value.trim());
      for (const f of need) f.classList.toggle("is-missing", missing.includes(f));
      error.hidden = !missing.length;
      if (missing.length) { missing[0].focus(); return; }

      const v = (n) => form.elements[n].value.trim();
      const text = [
        "Hello EasyPay, I would like a demo.",
        "",
        `Name: ${v("name")}`,
        `Restaurant: ${v("restaurant")}`,
        `Phone: ${v("phone")}`,
        v("note") ? `Note: ${v("note")}` : "",
      ].filter((line, i) => line || i === 1).join("\n");

      location.href = via === "whatsapp" && digits
        ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
        : `mailto:${cfg.email}?subject=${encodeURIComponent("Demo for " + v("restaurant"))}&body=${encodeURIComponent(text)}`;
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
