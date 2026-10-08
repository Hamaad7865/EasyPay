// platform-auth.test.mjs — the login a client is given (web/lib/platform-auth.ts).
// A login is made new, or an existing one that belongs to nobody is taken
// over with the password the admin typed. Anyone can make a login with the
// auth service directly, so whoever made that one may still be signed in:
// linked as it is, they would be signed in as the client's owner. Its open
// sessions are ended before it is handed over.
// The auth service and the database are stood in for: nothing is called.
// Usage: node web/lib/platform-auth.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("PASS " + name);
  } catch (e) {
    failures += 1;
    console.log("FAIL " + name + " " + (e && e.message ? e.message.split("\n")[0] : e));
  }
}

// The module as it is, with a stand-in auth service and database.
//   known: the login that exists for the email, if any: { id, linked, admin }
//   fails: which calls of the auth service answer with an error
function lib({ known = null, fails = [], throws = [] } = {}) {
  const calls = [];
  const call = (name, answer) => async (args) => {
    calls.push(name + (args && args.userId ? ":" + args.userId : ""));
    if (throws.includes(name)) throw new Error("network");
    if (fails.includes(name)) return { data: null, error: { message: name + " refused" } };
    return answer(args);
  };
  const stubs = {
    "@/lib/auth/server": {
      auth: {
        admin: {
          createUser: call("createUser", () => (known ? { data: null, error: { code: "USER_ALREADY_EXISTS", message: "User already exists" } } : { data: { user: { id: "new-user" } }, error: null })),
          setUserPassword: call("setUserPassword", () => ({ data: { status: true }, error: null })),
          revokeUserSessions: call("revokeUserSessions", () => ({ data: { success: true }, error: null })),
          removeUser: call("removeUser", () => ({ data: { success: true }, error: null })),
        },
      },
    },
    "@/lib/db": { db: () => ({ query: async () => ({ rows: known ? [known] : [] }) }) },
  };
  const js = ts.transpileModule(fs.readFileSync(path.join(here, "platform-auth.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", js)((name) => {
    if (stubs[name]) return stubs[name];
    throw new Error("an import this test has no stand-in for: " + name);
  }, mod, mod.exports);
  return { ...mod.exports, calls };
}
const input = { email: "owner@example.com", password: "a-good-password", name: "Owner" };

await check("an email with no login gets a new one, and nothing else is touched", async () => {
  const l = lib();
  const r = await l.loginForRestaurant(input);
  assert.deepEqual(r, { ok: true, userId: "new-user", created: true });
  assert.deepEqual(l.calls, ["createUser"]);
});

await check("a login that exists and belongs to nobody is taken over: its password is set, then its open sessions are ended", async () => {
  const l = lib({ known: { id: "old-user", linked: false, admin: false } });
  const r = await l.loginForRestaurant(input);
  assert.deepEqual(r, { ok: true, userId: "old-user", created: false });
  assert.deepEqual(l.calls, ["createUser", "setUserPassword:old-user", "revokeUserSessions:old-user"]);
});

await check("if its sessions cannot be ended it is not handed over: whoever made it could still be signed in", async () => {
  for (const how of [{ fails: ["revokeUserSessions"] }, { throws: ["revokeUserSessions"] }]) {
    const l = lib({ known: { id: "old-user", linked: false, admin: false }, ...how });
    const r = await l.loginForRestaurant(input);
    assert.equal(r.ok, false);
    assert.match(r.message, /sessions|reached/i);
    assert.ok(!("userId" in r));
  }
});

await check("if its password cannot be set, nothing more is done", async () => {
  const l = lib({ known: { id: "old-user", linked: false, admin: false }, fails: ["setUserPassword"] });
  const r = await l.loginForRestaurant(input);
  assert.equal(r.ok, false);
  assert.deepEqual(l.calls, ["createUser", "setUserPassword:old-user"]);
});

await check("a login that already belongs to a client, or is a platform admin's, is left exactly as it is", async () => {
  for (const known of [{ id: "old-user", linked: true, admin: false }, { id: "old-user", linked: false, admin: true }]) {
    const l = lib({ known });
    const r = await l.loginForRestaurant(input);
    assert.equal(r.ok, false);
    assert.deepEqual(l.calls, ["createUser"]);
  }
});

console.log(failures === 0 ? "PLATFORM AUTH PASS" : `PLATFORM AUTH FAIL (${failures})`);
process.exit(failures ? 1 : 0);
