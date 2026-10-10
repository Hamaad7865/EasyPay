// The relay between a guest's phone and a restaurant's till.
//
//   GET  /api/<store>/menu/<table>  the menu the till last published, that table's name, and whether orders are taken
//   POST /api/<store>/orders        an order from a table; answers its id
//   GET  /api/<store>/orders/<id>   where that order stands; as a WebSocket, told the moment it is answered
//   GET  /api/till                  a till's WebSocket: it publishes the menu, is handed each order and answers it
//
// <store> is the store's public id, made by EasyPay's server. A till does not
// say which store it is of: EasyPay's till service does. The relay hands it
// the credential the till already syncs with and is told which store that
// till belongs to and whether table ordering is on for it (TILL_API,
// `GET /guest/pass`), and takes the till to that store's room. So the relay
// keeps no secret, a tablet that is deactivated is turned away here as it is
// there, and nobody else can publish a menu or reach another store's room.
import { DurableObject } from "cloudflare:workers";
import { LIMITS, isStoreId, readMenu, readOrder, forPhones } from "./rules.js";

const json = (body, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

// A request's body as text when it is within `most` bytes, null when it is
// longer. It is read to its end either way, keeping no more than `most`.
async function bodyText(request, most) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const kept = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size <= most) kept.push(value);
  }
  if (size > most) return null;
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of kept) { all.set(part, at); at += part.byteLength; }
  return new TextDecoder().decode(all);
}

// Which store is this till of, and is table ordering on for it? EasyPay's
// till service is asked, with the till's own credential. Answers the store's
// public id, or what to tell the till.
async function vouchedFor(request, env) {
  const no = (answer) => ({ no: answer });
  const proof = request.headers.get("authorization") || "";
  if (!/^Device\s+\S{16,300}$/i.test(proof)) return no(json({ error: "a till gives its own credential" }, 401));
  const api = String(env.TILL_API || "").replace(/\/$/, "");
  if (!api) return no(json({ error: "the relay has not been told where EasyPay's till service is" }, 503));
  let r;
  try { r = await fetch(api + "/guest/pass", { headers: { authorization: proof } }); } catch { return no(json({ error: "EasyPay's till service did not answer" }, 503)); }
  if (r.status === 401 || r.status === 403) return no(json({ error: "this till is not known, or has been switched off" }, 401));
  if (!r.ok) return no(json({ error: "EasyPay's till service did not answer" }, 503));
  const pass = await r.json().catch(() => null);
  if (!pass || !isStoreId(pass.store)) return no(json({ error: "EasyPay's till service did not answer" }, 503));
  if (pass.ordering !== true) return no(json({ error: "table ordering is not switched on for this store", code: "off" }, 403));
  return { store: pass.store };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    // A body is always read to its end before anything is answered, whatever
    // it holds: an answer sent while one is still arriving stopped the local
    // server. What is over an order's size is read and thrown away.
    const drop = async (answer) => { await bodyText(request, 0); return answer; };

    // A till: EasyPay says whose it is, and it is taken to that store's room.
    if (pathname === "/api/till") {
      if (request.method !== "GET") return drop(json({ error: "not found" }, 404));
      if (request.headers.get("upgrade") !== "websocket") return json({ error: "a till connects with a WebSocket" }, 426);
      const till = await vouchedFor(request, env);
      if (till.no) return till.no;
      url.pathname = `/api/${till.store}/till`;
      return env.ROOMS.get(env.ROOMS.idFromName(till.store)).fetch(new Request(url, request));
    }

    const m = /^\/api\/([a-z2-7]{16})\/(menu|orders)(?:\/([A-Za-z0-9_-]{1,64}))?$/.exec(pathname);
    if (!m) return drop(json({ error: "not found" }, 404));
    const [, store, what, id] = m;
    const room = env.ROOMS.get(env.ROOMS.idFromName(store));
    if (request.method === "POST") {
      if (what !== "orders" || id) return drop(json({ error: "not found" }, 404));
      // an order is read here, whole and within its size, and handed on as text
      const text = await bodyText(request, LIMITS.orderBytes);
      if (text === null) return json({ error: "the order is too long", code: "invalid" }, 413);
      return room.fetch(new Request(request.url, { method: "POST", body: text }));
    }
    if (request.method !== "GET") return drop(json({ error: "not found" }, 404));
    return room.fetch(request);
  },
};

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => B32[b & 31]).join("");

// One store's room. Sockets are taken with the hibernation API: between
// messages the room is not in memory and nothing is billed for the time, and
// there are no timers or alarms here for the same reason. What has to outlast
// a sleep is in the room's SQLite store or on the socket (its tags and what
// is attached to it).
//
// Nothing is written until a till publishes a menu: an address nobody was
// given is answered "not in use" and leaves no store behind.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // a page or a till that says "ping" is answered without waking the room
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.made = undefined; // whether the room's tables exist, asked once a waking
    this.menu = undefined; // the menu with its tables, read once a waking
  }

  // ---- what is kept ----

  inUse() {
    if (this.made === undefined) this.made = this.sql.exec("select count(*) as n from sqlite_master where type = 'table' and name = 'meta'").one().n > 0;
    return this.made;
  }
  make() {
    if (this.inUse()) return;
    this.sql.exec(`
      create table if not exists meta (k text primary key, v text not null);
      create table if not exists orders (
        id text primary key, tbl text not null, body text not null, at integer not null,
        status text not null default 'waiting', reason text not null default '', answered_at integer
      );
    `);
    this.made = true;
  }
  kept(k) {
    if (!this.inUse()) return null;
    const row = this.sql.exec("select v from meta where k = ?", k).toArray()[0];
    return row ? row.v : null;
  }
  theMenu() {
    if (this.menu === undefined) {
      const text = this.kept("menu");
      this.menu = text ? { ...JSON.parse(text), tables: JSON.parse(this.kept("tables") || "[]") } : null;
    }
    return this.menu;
  }
  tills() { return this.ctx.getWebSockets("till"); }
  // orders are taken while a till is listening and has not said otherwise
  open(menu) { return !!menu && menu.accepting && this.tills().length > 0; }

  order(id) {
    if (!this.inUse()) return null;
    const row = this.sql.exec("select id, tbl, body, at, status, reason from orders where id = ?", id).toArray()[0];
    if (!row) return null;
    // one nobody answered in time is as good as not taken
    if (row.status === "waiting" && row.at < Date.now() - LIMITS.staleMs) row.status = "expired";
    return row;
  }
  standing(row) { return { id: row.id, status: row.status, reason: row.reason }; }
  forTill(row) { return { t: "order", order: { id: row.id, at: row.at, ...JSON.parse(row.body) } }; }

  // ---- requests ----

  async fetch(request) {
    const { pathname } = new URL(request.url);
    const [, , store, what, id] = pathname.split("/");
    const socket = request.headers.get("upgrade") === "websocket";

    // only the Worker sends a till here, once EasyPay has said whose it is
    if (what === "till") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["till"]);
      server.serializeAttachment({ since: Date.now() });
      const waiting = this.inUse() ? this.sql.exec("select id, tbl, body, at, status, reason from orders where status = 'waiting' and at >= ? order by at", Date.now() - LIMITS.staleMs).toArray() : [];
      // the till is told its store's public id: it is the address on its table cards
      server.send(JSON.stringify({ t: "hello", store, menu: this.kept("menu") !== null, waiting: waiting.length }));
      for (const row of waiting) server.send(JSON.stringify(this.forTill(row)));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (what === "menu" && id && request.method === "GET") {
      const menu = this.theMenu();
      if (!menu) return json({ error: "this code is not in use", code: "unknown" }, 404);
      const table = menu.tables.find((t) => t.c === id);
      if (!table) return json({ error: "this table's code is not in use", code: "table" }, 404);
      return json(`{"open":${this.open(menu)},"table":${JSON.stringify(table)},"menu":${this.kept("menu")}}`);
    }

    if (what === "orders" && !id && request.method === "POST") return this.place(request);

    if (what === "orders" && id && request.method === "GET") {
      const row = this.order(id);
      if (!row) return json({ error: "no such order" }, 404);
      if (!socket) return json(this.standing(row));
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["o:" + id]);
      server.send(JSON.stringify(this.standing(row)));
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: "not found" }, 404);
  }

  async place(request) {
    const text = await request.text(); // already within its size: the Worker read it
    const menu = this.theMenu();
    if (!menu) return json({ error: "this code is not in use", code: "unknown" }, 404);
    if (!this.open(menu)) return json({ error: "Not taking orders from the table right now. Please ask a member of staff.", code: "closed" }, 409);
    let raw;
    try { raw = JSON.parse(text); } catch { return json({ error: "the order could not be read", code: "invalid" }, 400); }
    const got = readOrder(raw, menu);
    if (got.error) return json({ error: got.error, code: got.code }, got.code === "table" ? 404 : 400);

    // A table may only have so many waiting. There is no count by phone: the
    // guests of one room share an address on its Wi-Fi, and the cashier's
    // "accept" is what stands between an order and the kitchen.
    const now = Date.now();
    const waiting = this.sql.exec("select count(*) as n from orders where tbl = ? and status = 'waiting' and at >= ?", got.order.table, now - LIMITS.staleMs).one().n;
    if (waiting >= LIMITS.waiting) return json({ error: "This table already has orders waiting for staff. Please give them a moment.", code: "busy" }, 429);

    // what is old is cleared as new orders come: there is no timer to do it
    this.sql.exec("delete from orders where at < ?", now - LIMITS.keepMs);
    const id = newId();
    this.sql.exec("insert into orders (id, tbl, body, at) values (?, ?, ?, ?)", id, got.order.table, JSON.stringify(got.order), now);
    const told = JSON.stringify(this.forTill({ id, at: now, body: JSON.stringify(got.order) }));
    for (const till of this.tills()) { try { till.send(told); } catch { /* a till that has just gone is told when it is back */ } }
    return json({ id });
  }

  // ---- what a till says over its socket ----

  async webSocketMessage(ws, message) {
    if (!this.ctx.getTags(ws).includes("till")) return; // a guest's socket only listens
    // A till that has been connected a long time proves again whose it is: it
    // is told to come back, and is asked about at the door as it was the first time.
    const held = ws.deserializeAttachment();
    if (!held || Date.now() - held.since > LIMITS.proofMs) { try { ws.close(4001, "prove again"); } catch { /* gone */ } return; }
    const say = (o) => { try { ws.send(JSON.stringify(o)); } catch { /* gone */ } };
    if (typeof message !== "string" || message.length > LIMITS.menuBytes) return say({ t: "no", error: "too long" });
    let m;
    try { m = JSON.parse(message); } catch { return say({ t: "no", error: "not understood" }); }

    if (m.t === "menu") {
      const got = readMenu(m.menu);
      if (got.error) return say({ t: "menu.no", error: got.error });
      this.make();
      const put = "insert into meta (k, v) values (?, ?) on conflict (k) do update set v = excluded.v";
      this.sql.exec(put, "menu", JSON.stringify(forPhones(got.menu)));
      this.sql.exec(put, "tables", JSON.stringify(got.menu.tables));
      this.menu = got.menu;
      return say({ t: "menu.ok", items: got.menu.items.length, tables: got.menu.tables.length });
    }

    if (m.t === "answer") {
      const status = m.status === "accepted" ? "accepted" : m.status === "declined" ? "declined" : null;
      const row = typeof m.id === "string" ? this.order(m.id) : null;
      if (!status || !row) return say({ t: "answer.no", id: m.id, error: "no such order" });
      if (row.status !== "waiting") {
        // answered already, here or on another till: the first answer stands
        return say({ t: row.status === status ? "answer.ok" : "answer.late", id: row.id, status: row.status });
      }
      const reason = status === "declined" && typeof m.reason === "string" ? m.reason.trim().slice(0, LIMITS.note) : "";
      this.sql.exec("update orders set status = ?, reason = ?, answered_at = ? where id = ?", status, reason, Date.now(), row.id);
      const told = JSON.stringify({ id: row.id, status, reason });
      for (const guest of this.ctx.getWebSockets("o:" + row.id)) { try { guest.send(told); guest.close(1000, "answered"); } catch { /* gone */ } }
      for (const till of this.tills()) if (till !== ws) { try { till.send(JSON.stringify({ t: "gone", id: row.id, status })); } catch { /* gone */ } }
      return say({ t: "answer.ok", id: row.id, status });
    }

    return say({ t: "no", error: "not understood" });
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed"); } catch { /* already closed */ }
  }
  async webSocketError() { /* the socket is gone; a till that was listening no longer counts as one */ }
}
