// The page Claude draws a card in (an MCP App, ui://easypay/card). It holds
// no data of its own: each tool result carries its card as HTML
// (structuredContent.html, drawn by lib/assistant/card.ts), and this page puts
// it on screen and gives its buttons what they do:
//   - Confirm calls the confirm tool, which only a card can call, with the
//     one-time code the result carried in its _meta (never in what the AI
//     reads), after the business's name was typed where the card asks it;
//   - Cancel calls cancel; a number in a stock grid calls history;
//   - a link opens through Claude.
// It speaks the MCP Apps messages by hand (JSON-RPC over postMessage, spec
// 2026-01-26): ui/initialize, then the tool results Claude sends, tools/call
// for the buttons, and its height as it changes. No library is loaded.

const SCRIPT = String.raw`
(() => {
  const root = document.getElementById("ep");
  let seq = 0, code = null;
  const waiting = new Map();
  const send = (m) => window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, m), "*");
  const ask = (method, params) => new Promise((ok, no) => { const id = ++seq; waiting.set(id, { ok, no }); send({ id, method, params }); });
  const tell = (method, params) => send({ method, params: params || {} });
  const draw = (r) => {
    if (!r) return;
    const html = r.structuredContent && r.structuredContent.html;
    const said = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (r._meta && r._meta["easypay/code"]) code = r._meta["easypay/code"];
    if (html) root.innerHTML = html;
    else if (said) { root.textContent = said; }
    size();
  };
  const size = () => tell("ui/notifications/size-changed", { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  const call = async (name, args, button) => {
    if (button) { button.disabled = true; button.dataset.was = button.textContent; button.textContent = "Working…"; }
    try { draw(await ask("tools/call", { name, arguments: args })); }
    catch (e) {
      if (button) { button.disabled = false; button.textContent = button.dataset.was; }
      const p = document.createElement("p"); p.className = "ep-err"; p.textContent = (e && e.message) || "That didn't go through. Try again.";
      root.appendChild(p); size();
    }
  };
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      if (m.error) w.no(m.error); else w.ok(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") draw(m.params);
    if (m.method === "ui/notifications/host-context-changed" && m.params && m.params.theme) document.documentElement.dataset.theme = m.params.theme;
    if (m.method === "ui/resource-teardown" && m.id !== undefined) send({ id: m.id, result: {} });
  });
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, a");
    if (!t) return;
    if (t.matches("a[href]")) { e.preventDefault(); ask("ui/open-link", { url: t.href }).catch(() => {}); return; }
    if (t.dataset.confirm) {
      const typed = root.querySelector("[data-type-name]");
      if (typed && typed.value.trim().toLowerCase() !== typed.dataset.typeName.trim().toLowerCase()) {
        typed.focus(); typed.classList.add("ep-wrong"); return;
      }
      call("confirm", { proposal: t.dataset.confirm, code: code || "" }, t);
    } else if (t.dataset.cancel !== undefined) {
      const p = root.querySelector("[data-confirm]");
      call("cancel", { proposal: p ? p.dataset.confirm : "" }, t);
    } else if (t.dataset.history) {
      call("history", { line: t.dataset.history }, null);
    }
  });
  new ResizeObserver(size).observe(document.body);
  ask("ui/initialize", { appInfo: { name: "EasyPay", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then((r) => {
      const theme = r && r.hostContext && r.hostContext.theme;
      if (theme) document.documentElement.dataset.theme = theme;
      tell("ui/notifications/initialized", {});
    })
    .catch(() => tell("ui/notifications/initialized", {}));
})();
`;

export function appHtml(css: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;padding:0;background:transparent;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.ep-err{color:#c0272d;font-size:13px;margin:8px 0 0}.ep-wrong{outline:2px solid #d93a40}${css}</style></head>
<body><div id="ep" class="ep"></div><script>${SCRIPT}</script></body></html>`;
}
