// EasyPay's mail: a till's Z report to the address its owner typed.
//
//   GET  /health        whether the service answers
//   POST /v1/ask        a till asks to mail an address: the address is mailed once, to confirm
//   POST /v1/state      whether the address has confirmed (yes, waiting, none)
//   POST /v1/z          a day closing's report, to an address that confirmed
//   POST /v1/stop       the till's setting was switched off: the address is forgotten for it
//   GET|POST /c/<token> the confirm page, and its button
//   GET|POST /s/<token> the stop page at the foot of each report, and its button
//
// EasyPay's database is never asked: an offline tablet must not wake it, and
// a till's credential is checked only there. So nothing a till says proves who
// it is, and the service is made so that it cannot mail anyone who did not
// ask: an address gets nothing but one short mail until someone presses
// Confirm on it, and then only from the till that asked, which proves it with
// a key of its own (only its hash is kept here). The mail is written here,
// never by the till. Everything kept is in one Durable Object, the Book.
import { DurableObject } from "cloudflare:workers";
import { LIMITS, readAsk, readWho, readZ, zMail, zShape, askMail, page, dayOf, refusal } from "./rules.js";
import { reportPdf, base64 } from "./pdf.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
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

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const hashOf = async (key) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => B32[b & 31]).join("");

const READ = { ask: readAsk, state: readWho, z: readZ, stop: readWho };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const drop = async (answer) => { await bodyText(request, 0); return answer; };
    const book = () => env.BOOK.get(env.BOOK.idFromName("book"));

    if (pathname === "/health") return drop(request.method === "GET" ? json({ ok: true }) : json({ error: "not found" }, 404));

    const v1 = /^\/v1\/(ask|state|z|stop)$/.exec(pathname);
    if (v1) {
      if (request.method !== "POST") return drop(json({ error: "not found" }, 404));
      const text = await bodyText(request, LIMITS.bodyBytes);
      if (text === null) return json({ error: "too long" }, 413);
      let raw;
      try { raw = JSON.parse(text); } catch { return json({ error: "not understood" }, 400); }
      const got = READ[v1[1]](raw);
      if (got.error) return json({ error: got.error }, 400);
      const { key, ...rest } = got;
      // the links in a mail are to the service's own address (SITE), never to the one a request came in by
      const origin = String(env.SITE || "https://mail.easypaypos.com").replace(/\/$/, "");
      const said = await book()[v1[1]]({ ...rest, keyHash: await hashOf(key), ip: request.headers.get("cf-connecting-ip") || "", origin });
      const { status = 200, ...answer } = said;
      return json(answer, status);
    }

    const link = /^\/([cs])\/([a-z2-7]{24})$/.exec(pathname);
    if (link) {
      const [, kind, t] = link;
      if (request.method === "GET") {
        const row = kind === "c" ? await book().asked(t) : await book().confirmed(t);
        if (!row) return html(page(kind === "c" ? "This link has expired" : "Already stopped", [kind === "c" ? "It is older than a week, or was used already. The till can send a new one." : "This address gets no more Z reports from that till."]), 404);
        return kind === "c"
          ? html(page("Confirm the Z reports", [`${row.business}'s till, ${row.till}, will send its Z report to ${row.address} at each day closing.`], "Confirm"))
          : html(page("Stop these emails?", [`${row.address} will get no more Z reports from ${row.business}'s till, ${row.till}.`], "Stop"));
      }
      if (request.method !== "POST") return drop(html(page("Not found", []), 404));
      await bodyText(request, 1024); // a form's button, or a mail client's one-click stop
      const row = kind === "c" ? await book().confirm(t) : await book().stopBy(t);
      if (!row) return html(page(kind === "c" ? "This link has expired" : "Already stopped", [kind === "c" ? "It is older than a week, or was used already. The till can send a new one." : "This address gets no more Z reports from that till."]), 404);
      return kind === "c"
        ? html(page("Confirmed", [`Each day closing of ${row.business}'s till, ${row.till}, will be emailed to ${row.address}.`, "Each report has a link at its foot to stop them."]))
        : html(page("Stopped", [`${row.address} will get no more Z reports from ${row.business}'s till, ${row.till}. The till can ask again.`]));
    }

    return drop(json({ error: "not found" }, 404));
  },
};

// What is kept, and every count, in one place: a few hundred requests a day
// at most, so one object is enough, and its store is consistent. Nothing runs
// between requests; what is old is cleared as new requests come.
//
//   asks    an address a till asked to mail, waiting for its Confirm (a week)
//   yes     an address that confirmed, for that till (its key's hash), and its stop token
//   ids     a Z mail's id, taken once: a till that did not hear the answer sends it again
//   counts  the day's counts, one row a thing counted, the day in its key
export class Book extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      create table if not exists asks (token text primary key, address text not null, key_hash text not null, business text not null, till text not null, at integer not null);
      create table if not exists yes (address text not null, key_hash text not null, business text not null, till text not null, at integer not null, stop text not null unique, primary key (address, key_hash));
      create table if not exists ids (id text primary key, at integer not null, done integer not null default 0);
      create table if not exists counts (k text primary key, n integer not null);
    `);
  }

  // ---- counting ----
  count(k) { return this.sql.exec("select n from counts where k = ?", `${dayOf(Date.now())}|${k}`).toArray()[0]?.n || 0; }
  bump(k, by = 1) { this.sql.exec("insert into counts (k, n) values (?, ?) on conflict (k) do update set n = n + excluded.n", `${dayOf(Date.now())}|${k}`, by); }
  tidy() {
    const now = Date.now();
    this.sql.exec("delete from counts where k < ?", dayOf(now));
    this.sql.exec("delete from asks where at < ?", now - LIMITS.askKeepMs);
    this.sql.exec("delete from ids where at < ?", now - LIMITS.idKeepMs);
  }

  confirmedFor(address, keyHash) { return this.sql.exec("select * from yes where address = ? and key_hash = ?", address, keyHash).toArray()[0] || null; }
  waitingFor(address, keyHash) { return this.sql.exec("select * from asks where address = ? and key_hash = ? and at >= ? order by at desc", address, keyHash, Date.now() - LIMITS.askKeepMs).toArray()[0] || null; }

  // A mail through Cloudflare; null when it went, or what its refusal means.
  // An attachment goes as its bytes: the binding takes a string as the file's
  // own content (a PDF given as base64 arrived as base64 text, 2026-10-25).
  // Wrangler's local stand-in for the binding cannot carry bytes ("Cannot
  // serialize"): there, and only there, the file goes as base64 text.
  async send(mail) {
    try { await this.env.EMAIL.send(mail); return null; }
    catch (e) {
      if (mail.attachments && /serialize/i.test(String(e && e.message))) {
        console.log(JSON.stringify({ mail: "attachment as text", why: "the local stand-in for the binding takes no bytes" }));
        return this.send({ ...mail, attachments: mail.attachments.map((a) => ({ ...a, content: typeof a.content === "string" ? a.content : base64(a.content) })) });
      }
      console.log(JSON.stringify({ mail: "refused", code: e && e.code, message: e && e.message }));
      return refusal(e && e.code);
    }
  }

  // ---- what a till asks (index.js has read and checked it) ----

  async ask({ to, keyHash, business, till, ip, origin }) {
    this.tidy();
    const yes = this.confirmedFor(to, keyHash);
    if (yes) {
      this.sql.exec("update yes set business = ?, till = ? where address = ? and key_hash = ?", business, till, to, keyHash);
      return { state: "yes" };
    }
    const last = this.waitingFor(to, keyHash);
    if (last && last.at >= Date.now() - LIMITS.askEveryMs) return { state: "waiting" };
    if (this.count("ask:a:" + to) >= LIMITS.asksPerAddress || (ip && this.count("ask:ip:" + ip) >= LIMITS.asksPerIp) || this.count("ask") >= LIMITS.asks) {
      return { state: last ? "waiting" : "none", error: "too many emails to confirm today: try again tomorrow", status: 429 };
    }
    const t = token();
    // counted before the mail goes, and given back if it does not
    this.sql.exec("insert into asks (token, address, key_hash, business, till, at) values (?, ?, ?, ?, ?, ?)", t, to, keyHash, business, till, Date.now());
    this.bump("ask:a:" + to); if (ip) this.bump("ask:ip:" + ip); this.bump("ask");
    const no = await this.send(askMail({ to, business, till }, `${origin}/c/${t}`));
    if (no) {
      this.sql.exec("delete from asks where token = ?", t);
      this.bump("ask:a:" + to, -1); if (ip) this.bump("ask:ip:" + ip, -1); this.bump("ask", -1);
      return { state: last ? "waiting" : "none", error: no.words, code: no.kind, status: no.kind === "refused" ? 422 : 503 };
    }
    return { state: "waiting" };
  }

  async state({ to, keyHash }) {
    return { state: this.confirmedFor(to, keyHash) ? "yes" : this.waitingFor(to, keyHash) ? "waiting" : "none" };
  }

  async z({ to, keyHash, id, origin, ...report }) {
    this.tidy();
    const yes = this.confirmedFor(to, keyHash);
    if (!yes) return { state: this.waitingFor(to, keyHash) ? "waiting" : "none", error: "this address has not confirmed", status: 403 };
    const had = this.sql.exec("select done, at from ids where id = ?", id).toArray()[0];
    if (had && had.done) return { state: "yes", sent: true };
    // being sent by a request still going; one cut off before it was told how it went is sent again after two minutes
    if (had && had.at >= Date.now() - 120000) return { state: "yes", error: "this report is being sent", status: 409 };
    if (had) this.sql.exec("delete from ids where id = ?", id);
    if (this.count("z:a:" + to) >= LIMITS.zPerAddress || this.count("z") >= LIMITS.z) return { state: "yes", error: "too many reports today: the rest go tomorrow", status: 429 };
    this.sql.exec("insert into ids (id, at) values (?, ?)", id, Date.now());
    this.bump("z:a:" + to); this.bump("z");
    // the same report as a PDF; a report that cannot be made into one still goes, without it
    let pdf = null;
    try { pdf = await reportPdf(zShape(report), report); } catch (e) { console.log(JSON.stringify({ pdf: "not made", message: e && e.message })); }
    const no = await this.send(zMail({ to, ...report }, `${origin}/s/${yes.stop}`, pdf));
    if (no) {
      this.sql.exec("delete from ids where id = ?", id);
      this.bump("z:a:" + to, -1); this.bump("z", -1);
      return { state: "yes", error: no.words, code: no.kind, status: no.kind === "refused" ? 422 : 503 };
    }
    this.sql.exec("update ids set done = 1 where id = ?", id);
    return { state: "yes", sent: true };
  }

  async stop({ to, keyHash }) {
    this.sql.exec("delete from yes where address = ? and key_hash = ?", to, keyHash);
    this.sql.exec("delete from asks where address = ? and key_hash = ?", to, keyHash);
    return { state: "none" };
  }

  // ---- the pages a mail links to ----

  async asked(t) {
    return this.sql.exec("select * from asks where token = ? and at >= ?", t, Date.now() - LIMITS.askKeepMs).toArray()[0] || null;
  }

  async confirm(t) {
    const row = await this.asked(t);
    if (!row) return null;
    this.sql.exec(
      "insert into yes (address, key_hash, business, till, at, stop) values (?, ?, ?, ?, ?, ?) on conflict (address, key_hash) do update set business = excluded.business, till = excluded.till",
      row.address, row.key_hash, row.business, row.till, Date.now(), token(),
    );
    this.sql.exec("delete from asks where address = ? and key_hash = ?", row.address, row.key_hash);
    return row;
  }

  async confirmed(t) { return this.sql.exec("select * from yes where stop = ?", t).toArray()[0] || null; }

  async stopBy(t) {
    const row = await this.confirmed(t);
    if (row) this.sql.exec("delete from yes where stop = ?", t);
    return row;
  }
}
