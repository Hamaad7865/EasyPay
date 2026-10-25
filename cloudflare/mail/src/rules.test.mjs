// node --test cloudflare/mail/src/rules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, addressOf, nameOf, readAsk, readWho, readZ, zMail, askMail, page, esc, refusal } from "./rules.js";

const KEY = "a".repeat(64);
const z = (over = {}) => ({ to: "Owner@Example.MU", key: KEY, id: "0190f1c2-aaaa-7bbb", number: 12, date: "25/10/2026 23:10", lines: ["  DAY CLOSING (Z) No. 12", "Sales            1,250.00"], business: "Chez Ravi", till: "Till 1", ...over });

test("an address is kept in small letters, and what is not one is refused", () => {
  assert.equal(addressOf("  Owner@Example.MU "), "owner@example.mu");
  assert.equal(addressOf("a.b+z@mail.co.uk"), "a.b+z@mail.co.uk");
  for (const bad of ["", "owner", "owner@", "@example.mu", "owner@example", "own er@example.mu", "a@b.c", "<a@b.mu>", "a..b@x.mu", ".a@x.mu", "a@-x.mu", "a@x.mu, b@y.mu", 42, null]) {
    assert.equal(addressOf(bad), null, String(bad));
  }
  assert.equal(addressOf("a".repeat(65) + "@x.mu"), null);
});

test("a name is one line, has no link in it, and keeps to its length", () => {
  assert.equal(nameOf("  Chez\nRavi\t ", 80), "Chez Ravi");
  assert.equal(nameOf("Best deals https://spam.example/x now www.spam.example", 80), "Best deals now");
  assert.equal(nameOf("x".repeat(200), LIMITS.business).length, LIMITS.business);
  assert.equal(nameOf(7, 80), "");
});

test("an ask needs an address, the till's key and the business", () => {
  assert.deepEqual(readAsk({ to: "o@x.mu", key: KEY, business: "Chez Ravi", till: "Till 1" }), { to: "o@x.mu", key: KEY, business: "Chez Ravi", till: "Till 1" });
  assert.equal(readAsk({ to: "o@x.mu", key: KEY, business: "Chez Ravi" }).till, "Till");
  assert.match(readAsk({ to: "nope", key: KEY, business: "B" }).error, /email address/);
  assert.match(readAsk({ to: "o@x.mu", key: "short", business: "B" }).error, /key/);
  assert.match(readAsk({ to: "o@x.mu", key: KEY.toUpperCase(), business: "B" }).error, /key/);
  // a business with no name, or one that was only a link, is EasyPay's
  assert.equal(readAsk({ to: "o@x.mu", key: KEY, business: "https://x.y" }).business, "EasyPay");
  assert.equal(readZ(z({ business: "" })).business, "EasyPay");
  assert.match(readAsk(null).error, /not understood/);
  assert.deepEqual(readWho({ to: "O@X.mu", key: KEY }), { to: "o@x.mu", key: KEY });
});

test("a report is read within its limits", () => {
  const got = readZ(z());
  assert.equal(got.to, "owner@example.mu");
  assert.equal(got.number, 12);
  assert.equal(got.test, false);
  assert.deepEqual(got.lines, ["  DAY CLOSING (Z) No. 12", "Sales            1,250.00"]);
  // a control character is a space, a line's end loses its spaces, a long line is cut
  assert.deepEqual(readZ(z({ lines: ["a\u0007b   ", "x".repeat(300)] })).lines, ["a b", "x".repeat(LIMITS.lineChars)]);
  assert.match(readZ(z({ lines: [] })).error, /empty/);
  assert.match(readZ(z({ lines: Array(LIMITS.lines + 1).fill("x") })).error, /too long/);
  assert.match(readZ(z({ lines: ["a", 3] })).error, /could not be read/);
  assert.match(readZ(z({ id: "x" })).error, /id/);
  assert.match(readZ(z({ number: 0 })).error, /number/);
  assert.match(readZ(z({ number: 1.5 })).error, /number/);
  assert.equal(readZ(z({ date: "<b>" })).date, "");
  assert.equal(readZ(z({ test: true })).test, true);
  assert.equal(readZ(z({ test: "yes" })).test, false);
});

test("the report's mail escapes every character the till sent", () => {
  const r = readZ(z({ business: "Ravi & <Sons>", lines: ["<script>alert(1)</script>", "Total   Rs 1,250.00"] }));
  const m = zMail(r, "https://mail.easypaypos.com/s/abc");
  assert.equal(m.subject, "Z report No. 12 · Ravi & <Sons> · Till 1 · 25/10/2026 23:10");
  assert.ok(!m.html.includes("<script>"));
  assert.ok(m.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(m.html.includes("Ravi &amp; &lt;Sons&gt;"));
  assert.ok(m.text.startsWith("<script>alert(1)</script>\nTotal   Rs 1,250.00\n"));
  assert.ok(m.text.includes("Stop these emails: https://mail.easypaypos.com/s/abc"));
  assert.equal(m.headers["List-Unsubscribe"], "<https://mail.easypaypos.com/s/abc>");
  assert.equal(m.from.email, "reports@easypaypos.com");
  assert.equal(m.to, "owner@example.mu");
});

test("a report made while the tablet is setting up says TEST in its subject", () => {
  assert.match(zMail(readZ(z({ test: true })), "s").subject, /^TEST · Z report No\. 12/);
});

test("the mail to confirm names the business and the till, and links to the confirm page", () => {
  const m = askMail({ to: "o@x.mu", business: "Chez <Ravi>", till: "Till 1" }, "https://mail.easypaypos.com/c/tok");
  assert.equal(m.subject, "Confirm: Z reports of Chez <Ravi> to this address");
  assert.ok(m.text.includes("Confirm: https://mail.easypaypos.com/c/tok"));
  assert.ok(m.html.includes("Chez &lt;Ravi&gt;"));
  assert.ok(m.html.includes('href="https://mail.easypaypos.com/c/tok"'));
});

test("a page's button posts to the page itself, and its words are escaped", () => {
  const p = page("Confirm", ["<b>x</b>"], "Confirm");
  assert.ok(p.includes('<form method="post"><button type="submit">Confirm</button></form>'));
  assert.ok(p.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(!page("Done", ["ok"]).includes("<form"));
  assert.equal(esc(`"'&`), "&quot;&#39;&amp;");
});

test("Cloudflare's refusals are never-for-this-address or later", () => {
  assert.equal(refusal("E_RECIPIENT_SUPPRESSED").kind, "refused");
  assert.equal(refusal("E_VALIDATION_ERROR").kind, "refused");
  for (const c of ["E_SENDER_NOT_VERIFIED", "E_RECIPIENT_NOT_ALLOWED", "E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR", undefined]) assert.equal(refusal(c).kind, "later", String(c));
});
