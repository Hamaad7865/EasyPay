// The relay between a guest's phone and a restaurant's till.
//
//   GET  /api/<store>/menu          the menu the till last published, and whether orders are taken
//   POST /api/<store>/orders        an order from a table; answers its id
//   GET  /api/<store>/orders/<id>   where that order stands; as a WebSocket, told the moment it is answered
//   GET  /api/<store>/till          a till's WebSocket: it proves the store's key, publishes the menu,
//                                   is handed each order and answers it
//
// <store> is worked out from the store's key (rules.js), so the Worker can
// tell a till of that store from anyone else without keeping a secret or
// asking a database. Everything of one store lives in one room.
import { DurableObject } from "cloudflare:workers";
import { LIMITS, storeId, isKey, readMenu, readOrder } from "./rules.js";

const json = (body, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const m = /^\/api\/([a-z2-7]{16})\/(menu|orders|till)(?:\/([a-z2-7]{12}))?$/.exec(pathname);
    // A body is always read to its end before anything is answered, whatever
    // it holds: an answer sent while one is still arriving stopped the local
    // server. What is over an order's size is read and thrown away.
    const drop = async (answer) => { await bodyText(request, 0); return answer; };
    if (!m) return drop(json({ error: "not found" }, 404));
    const [, store, what, id] = m;
    const room = env.ROOMS.get(env.ROOMS.idFromName(store));
    if (request.method === "POST") {
      if (what !== "orders" || id) return drop(json({ error: "not found" }, 404));
      // an order is read here, whole and within its size, and handed on as text
      const text = await bodyText(request, LIMITS.orderBytes);
      if (text === null) return json({ error: "the order is too long", code: "invalid" }, 413);
      return room.fetch(new Request(request.url, { method: "POST", headers: { "x-from": request.headers.get("cf-connecting-ip") || "?" }, body: text }));
    }
    if (request.method !== "GET") return drop(json({ error: "not found" }, 404));
    if (what === "till") {
      // before a room is even reached: the key has to be this store's
      const key = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!isKey(key) || (await storeId(key)) !== store) return json({ error: "this is not the store's key" }, 401);
    }
    return room.fetch(request);
  },
};

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

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => B32[b & 31]).join("");

// One store's room. Sockets are taken with the hibernation API: between
// messages the room is not in memory and nothing is billed for the time, and
// there are no timers or alarms here for the same reason. What has to outlast
// a sleep is in the room's SQLite store or on the socket (its tags).
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      create table if not exists meta (k text primary key, v text not null);
      create table if not exists orders (
        id text primary key, tbl text not null, body text not null, at integer not null,
        status text not null default 'waiting', reason text not null default '', answered_at integer
      );
    `);
    // a page or a till that says "ping" is answered without waking the room
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.menu = undefined; // the menu, read once a waking
    this.recent = new Map(); // orders lately sent from one address; forgotten at each sleep, which is enough
  }

  // ---- what is kept ----

  menuText() {
    const row = this.sql.exec("select v from meta where k = 'menu'").toArray()[0];
    return row ? row.v : null;
  }
  theMenu() {
    if (this.menu === undefined) { const t = this.menuText(); this.menu = t ? JSON.parse(t) : null; }
    return this.menu;
  }
  tills() { return this.ctx.getWebSockets("till"); }
  // orders are taken while a till is listening and has not said otherwise
  open(menu) { return !!menu && menu.accepting && this.tills().length > 0; }

  order(id) {
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
    const [, , , what, id] = pathname.split("/");
    const socket = request.headers.get("upgrade") === "websocket";

    if (what === "till") {
      if (!socket) return json({ error: "a till connects with a WebSocket" }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["till"]);
      const waiting = this.sql.exec("select id, tbl, body, at, status, reason from orders where status = 'waiting' and at >= ? order by at", Date.now() - LIMITS.staleMs).toArray();
      server.send(JSON.stringify({ t: "hello", menu: this.menuText() !== null, waiting: waiting.length }));
      for (const row of waiting) server.send(JSON.stringify(this.forTill(row)));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (what === "menu" && request.method === "GET") {
      const text = this.menuText();
      if (text === null) return json({ error: "this code is not in use", code: "unknown" }, 404);
      return json(`{"open":${this.open(this.theMenu())},"menu":${text}}`);
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

    const now = Date.now();
    // one phone that sends order upon order is asked to wait
    const from = request.headers.get("x-from") || "?";
    const lately = (this.recent.get(from) || []).filter((t) => t > now - 10 * 60 * 1000);
    if (lately.length >= 8) return json({ error: "Too many orders from this phone. Please ask a member of staff.", code: "busy" }, 429);
    const waiting = this.sql.exec("select count(*) as n from orders where tbl = ? and status = 'waiting' and at >= ?", got.order.table, now - LIMITS.staleMs).one().n;
    if (waiting >= LIMITS.waiting) return json({ error: "This table already has orders waiting for staff. Please give them a moment.", code: "busy" }, 429);
    this.recent.set(from, [...lately, now]);

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
    const say = (o) => { try { ws.send(JSON.stringify(o)); } catch { /* gone */ } };
    if (typeof message !== "string" || message.length > LIMITS.menuBytes) return say({ t: "no", error: "too long" });
    let m;
    try { m = JSON.parse(message); } catch { return say({ t: "no", error: "not understood" }); }

    if (m.t === "menu") {
      const got = readMenu(m.menu);
      if (got.error) return say({ t: "menu.no", error: got.error });
      this.sql.exec("insert into meta (k, v) values ('menu', ?) on conflict (k) do update set v = excluded.v", JSON.stringify(got.menu));
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
