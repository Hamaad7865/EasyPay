import { Hono } from "hono";
import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Till API (Neon Functions). Contract enforced:
// - JWT comes from Neon Auth (Better Auth). No custom claims.
// - After verify, employees.auth_user_id -> tenant lookup; every tenant query
//   then runs in one transaction as app_user with app.tenant_id set (asTenant).
// - tenant_id is never trusted from the payload (spec 4.2.3, 15).
// - Tenants are created by the platform admin in the web admin area. There is
//   no sign-up here: a login that is not linked to a tenant gets 403.
// - A suspended tenant keeps syncing (spec 4.4: never trap their data) but
//   cannot register devices or change its catalog.
// - A till is set up, and given its key, only under a login that may set up
//   tills (settings.device): the server takes a till's word for who did what
//   from such a login alone.
// - A till that has been set up syncs with a key of its own (migration 0063),
//   which does not lapse the way a login's session does. The key opens the
//   sync routes only (push, pull of the till's own store, crash reports); it
//   is made and checked in SQL, and only its SHA-256 is kept.

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL!));
  return jwks;
}
function issuer(): string {
  return new URL(process.env.NEON_AUTH_BASE_URL!).origin;
}

// deviceId and storeId are set when the caller is a till with its key, not a login.
type Authed = { authUserId: string; tenantId: string; employeeId: string; status: string; deviceId?: string; storeId?: string };

async function requireAuth(req: Request): Promise<Authed> {
  const h = req.headers.get("authorization") ?? "";
  if (!h.toLowerCase().startsWith("bearer ")) throw new Response("Unauthorized", { status: 401 });
  let sub: string;
  try {
    const { payload } = await jwtVerify(h.slice(7), getJwks(), { issuer: issuer() });
    if (!payload.sub) throw new Error("no sub");
    sub = payload.sub;
  } catch {
    throw new Response("Unauthorized", { status: 401 });
  }
  // Lookup runs as owner (BYPASSRLS) — scoping happens below via SET ROLE + GUC.
  const found = await pool.query(
    `select e.id, e.tenant_id, t.status
       from employees e join tenants t on t.id = e.tenant_id
      where e.auth_user_id = $1 and e.deleted_at is null and e.is_active`,
    [sub],
  );
  if (found.rowCount !== 1) throw new Response("Forbidden: no tenant linked", { status: 403 });
  return { authUserId: sub, tenantId: found.rows[0].tenant_id, employeeId: found.rows[0].id, status: found.rows[0].status };
}

// A till's own key: "Authorization: Device <deviceId>:<key>". It stands for
// the login that set the till up, so everything sync_push decides by who is
// pushing stays as it is. A login's Bearer token is taken as before.
//   401  not this till's key, or one that was ended
//   403  the till was deactivated, or the login that set it up was switched off
// Either way the till drops the key and goes back to its login, as before
// tills had keys: whoever is signed in on it can still send its sales, and a
// till that is not deactivated is given a new key under that login.
const TILL_OFF = { error: "This till was deactivated. Contact EasyPay to reactivate it." };
const LOGIN_OFF = { error: "The login that set this till up was switched off. Sign in on the till again." };
type KeyAnswer = { ok: boolean; why?: string; employee_id?: string; tenant_id?: string; store_id?: string; status?: string };

function refused(body: { error: string }): Response {
  return new Response(JSON.stringify(body), { status: 403, headers: { "content-type": "application/json" } });
}

async function requireTill(req: Request): Promise<Authed> {
  const h = req.headers.get("authorization") ?? "";
  if (!h.toLowerCase().startsWith("device ")) return requireAuth(req);
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{64})$/i.exec(h.slice(7).trim());
  if (!m) throw new Response("Unauthorized", { status: 401 });
  let r: KeyAnswer | undefined;
  try {
    // Runs as owner, like the login lookup: no tenant is known yet.
    r = (await pool.query(`select device_login($1::uuid, $2) as r`, [m[1], m[2].toLowerCase()])).rows[0]?.r;
  } catch (err) {
    console.error("till key check failed:", (err as Error).message);
    throw new Response("Service unavailable", { status: 503 });
  }
  if (!r?.ok || !r.tenant_id || !r.employee_id) {
    if (r?.why === "till-off") throw refused(TILL_OFF);
    if (r?.why === "login-off") throw refused(LOGIN_OFF);
    throw new Response("Unauthorized", { status: 401 });
  }
  return { authUserId: "", tenantId: r.tenant_id, employeeId: r.employee_id, status: r.status ?? "active", deviceId: m[1].toLowerCase(), storeId: r.store_id };
}

// When a till was last heard from, for the back office's Point of sale page
// (migration 0064: a table no till pulls). `what` is "push" when it sent what
// it had, "pull" when it fetched, "seen" otherwise. Written only for a till
// that is known: one syncing with its own key, or one being set up. It is
// never in the way of the sync: a failure here is logged and the answer goes
// out as it was. It is awaited, because the function may be stopped as soon
// as it has answered.
async function heard(req: Request, deviceId: string | undefined, what: "push" | "pull" | "seen"): Promise<void> {
  if (!deviceId) return;
  const v = Number(req.headers.get("x-till-version") ?? "");
  try {
    await pool.query(`select device_heard($1::uuid, $2, $3::int)`, [deviceId, what, Number.isInteger(v) && v > 0 && v < 1_000_000_000 ? v : null]);
  } catch (err) {
    console.error("till activity not written:", (err as Error).message);
  }
}

// A shop's till must be build 3 or later: the first with a shop's screens. An
// older build would ring a shop's sales up as a restaurant's orders and send
// them to a kitchen that is not there. It is answered 426, as a build below
// MIN_TILL_VERSION is: the till says it must be updated, keeps selling and
// keeps its outbox, and syncs again once it is. A till that does not say its
// build is an older one still. A restaurant's till is asked nothing new, and
// a build that is new enough costs no query.
const SHOP_MIN_TILL = 3;
async function tooOldForShop(req: Request, tenantId: string): Promise<boolean> {
  const v = Number(req.headers.get("x-till-version") ?? "0");
  if (Number.isInteger(v) && v >= SHOP_MIN_TILL) return false;
  try {
    const r = await pool.query(`select business_type from tenants where id = $1::uuid`, [tenantId]);
    return r.rows[0]?.business_type === "retail";
  } catch (err) {
    // never in the way of a sync: a till that cannot be asked about is let through
    console.error("business type not read:", (err as Error).message);
    return false;
  }
}
const SHOP_TOO_OLD = { error: "This till must be updated before it can sync: this business is a shop, and this build has no shop screens.", min: SHOP_MIN_TILL };

const SUSPENDED = { error: "This account is suspended. Sales already made still sync; contact EasyPay to reactivate." };
function suspended(auth: Authed): boolean {
  return auth.status !== "active";
}

// A till is set up, and given its key, only under a login that may set up
// tills (settings.device: the owner's, a manager's). The server takes a
// till's word for who rang something up, and who approved it, from such a
// login alone (sync_push). A till set up under a cashier's login would have
// every approval ignored: a refund a manager approved with their PIN there
// would be refused after the money had moved. So that login is told at
// set-up which one to use, where it costs nothing yet.
const NOT_FOR_TILLS = { error: "This login cannot set up a till. Set it up with the owner's or a manager's login; staff then use their PIN." };
async function maySetUpTills(employeeId: string): Promise<boolean> {
  const r = await pool.query(`select has_perm($1, 'settings.device') as ok`, [employeeId]);
  return r.rows[0]?.ok === true;
}

// Runs fn on one pooled client with the tenant context stamped for the txn.
// Exported for db/tests/helpers.test.cjs (keep in sync with web/lib/db.ts).
export async function asTenant<T>(tenantId: string, fn: (q: (text: string, params?: unknown[]) => Promise<{ rows: T[] }>) => Promise<T[]>): Promise<T[]> {
  const client = await pool.connect();
  try {
    // One explicit transaction: SET LOCAL only lives inside a txn block, SET
    // takes no bind parameters (so the GUC goes through set_config()), and
    // a throw in fn rolls everything back. SET LOCAL ROLE needs no RESET.
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const q = (text: string, params?: unknown[]) => client.query(text, params);
    const out = await fn(q as never);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    throw e;
  } finally {
    client.release();
  }
}

// How a failed sync call is answered. What the till cannot fix by trying again
// (a batch that is not a batch, a store or a login that is not there) is 400,
// and the till stops. Anything else is the database being busy, asleep or cut
// off: 503, which the till retries with a growing pause, so nothing waits in
// its outbox until the next sale.
function syncFailure(what: string, err: unknown): 400 | 503 {
  const msg = (err as Error)?.message ?? "";
  console.error(what + " failed:", msg);
  return /unknown-employee|bad-batch|unknown store|invalid input syntax/.test(msg) ? 400 : 503;
}

const app = new Hono();

// A till says which build it is (X-Till-Version: its versionCode). When
// MIN_TILL_VERSION is set and the till is older, every call is answered 426:
// the till shows "must be updated", keeps selling and keeps its outbox, and
// syncs again once it is updated. With the setting absent, or from a till
// that does not say its version, nothing changes.
// GET /health is answered whatever build asks: it is where a till learns that
// there is a newer build and where its file is, and a till too old to sync is
// the one that most needs to know.
app.use("*", async (c, next) => {
  const min = Number(process.env.MIN_TILL_VERSION ?? "0");
  const has = c.req.header("x-till-version");
  if (c.req.path !== "/health" && min > 0 && has !== undefined && Number(has) < min) {
    return c.json({ error: "This till must be updated before it can sync.", min }, 426);
  }
  await next();
});

// The newest build of the till there is to install: its versionCode, the name
// people know it by ("0.4.0"), and where its APK is. The three are given at
// deploy (LATEST_TILL_VERSION, LATEST_TILL_NAME, TILL_APK_URL, see neon.ts).
// Without a version or an https address there is no update to offer, and a
// till is told nothing. The file itself is hosted wherever the address says:
// the API only passes the address on.
function latestTill(): { version: number; name: string; url: string } | null {
  const version = Math.trunc(Number(process.env.LATEST_TILL_VERSION ?? "0")) || 0;
  const url = (process.env.TILL_APK_URL ?? "").trim();
  if (version <= 0 || !/^https:\/\/\S+$/i.test(url)) return null;
  return { version, name: (process.env.LATEST_TILL_NAME ?? "").trim() || `build ${version}`, url };
}

// minTill: the oldest till build still accepted (0: every build is).
// till: the newest build there is to install, or null (the till's update key asks here).
app.get("/health", (c) =>
  c.json({ ok: true, branch: process.env.NEON_BRANCH ?? "unknown", build: "v2-0082", minTill: Number(process.env.MIN_TILL_VERSION ?? "0") || 0, till: latestTill() }),
);

// Tenant-scoped self check: only ever returns the caller's own rows.
app.get("/me", async (c) => {
  let auth: Authed;
  try {
    auth = await requireAuth(c.req.raw);
  } catch (res) {
    return res as Response;
  }
  const tenants = await asTenant<{ id: string; name: string }>(auth.tenantId, (q) => q(`select id, name from tenants`).then((r) => r.rows));
  const stores = await asTenant<{ id: string; name: string; code: string }>(auth.tenantId, (q) => q(`select id, name, code from stores order by name`).then((r) => r.rows));
  return c.json({ tenantId: auth.tenantId, status: auth.status, tenants, stores });
});

// Seeds the Le Flamboyant demo catalog into the caller's tenant (Phase 1).
// Requires items.edit (checked in SQL, not by role name). Refuses if the
// tenant already has categories.
app.post("/seed-demo", async (c) => {
  let auth: Authed;
  try {
    auth = await requireAuth(c.req.raw);
  } catch (res) {
    return res as Response;
  }
  if (suspended(auth)) return c.json(SUSPENDED, 403);
  const allowed = await pool.query(`select has_perm($1, 'items.edit') as ok`, [auth.employeeId]);
  if (!allowed.rows[0]?.ok) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const seeded = await pool.query(`select seed_demo_catalog($1) as r`, [auth.tenantId]);
  return c.json(seeded.rows[0].r);
});

// Device registration for store/device selection (Phase 1).
// Upsert on the client-minted device id (spec 15, required). A code already
// held by ANOTHER device in the store is 409 (two tills on the default T1
// must never merge into one row and share a receipt sequence). Receipt
// sequence lives on the row so reinstalls resume (spec 5.7).
app.post("/devices/register", async (c) => {
  let auth: Authed;
  try {
    auth = await requireAuth(c.req.raw);
  } catch (res) {
    return res as Response;
  }
  if (suspended(auth)) return c.json(SUSPENDED, 403);
  if (!(await maySetUpTills(auth.employeeId))) return c.json(NOT_FOR_TILLS, 403);
  type DeviceBody = { storeId?: string; deviceId?: string; name?: string; code?: string; appVersion?: string };
  const body: DeviceBody = await c.req.json<DeviceBody>().catch((): DeviceBody => ({}));
  const storeId = body.storeId ?? "";
  const name = (body.name ?? "Terminal").trim();
  const code = (body.code ?? "T1").trim().toUpperCase();
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return c.json({ error: "storeId required" }, 400);
  if (!name || !/^[A-Z0-9]{1,12}$/.test(code)) return c.json({ error: "name and code (A-Z0-9, 1-12) required" }, 400);
  if (!body.deviceId || !/^[0-9a-f-]{36}$/i.test(body.deviceId)) {
    return c.json({ error: "deviceId required (client-minted UUID)" }, 400);
  }
  const deviceId = body.deviceId;
  try {
    // A till the platform admin deactivated stays deactivated: registering
    // again must not quietly bring it back. Its unsynced sales still push.
    const known = await asTenant<{ deactivated: boolean }>(auth.tenantId, (q) =>
      q(`select deleted_at is not null as deactivated from pos_devices where id = $1 and tenant_id = $2`, [deviceId, auth.tenantId]).then((r) => r.rows),
    );
    if (known[0]?.deactivated) {
      return c.json({ error: "This till was deactivated. Contact EasyPay to reactivate it." }, 403);
    }
    const rows = await asTenant<{ id: string; last_receipt_seq: string }>(auth.tenantId, (q) =>
      q(
        `insert into pos_devices (id, tenant_id, store_id, name, code, app_version, last_seen_at)
           values ($1, $2, $3, $4, $5, $6, now())
         on conflict (id) do update
           set name = excluded.name, code = excluded.code, app_version = excluded.app_version,
             last_seen_at = now()
         returning id, last_receipt_seq`,
        [deviceId, auth.tenantId, storeId, name, code, body.appVersion ?? null],
      ).then((r) => r.rows),
    );
    // The till's own key for syncing, given once. Without it the till still
    // syncs with its login, as before, so a failure here is not a failed set-up.
    let syncKey: string | undefined;
    try {
      syncKey = (await pool.query(`select issue_device_key($1::uuid, $2::uuid) as k`, [auth.employeeId, rows[0].id])).rows[0]?.k;
    } catch (err) {
      console.error("key for a new till failed:", (err as Error).message);
    }
    await heard(c.req.raw, rows[0].id, "seen");
    return c.json({ deviceId: rows[0].id, lastReceiptSeq: Number(rows[0].last_receipt_seq), ...(syncKey ? { syncKey } : {}) });
  } catch (err) {
    const msg = (err as Error).message;
    console.error("register failed:", msg);
    if (msg.includes("pos_devices_tenant_id_store_id_code_key")) {
      return c.json({ error: "device code already registered in this store" }, 409);
    }
    return c.json({ error: "register failed" }, 400);
  }
});

// A key for a till that was set up before tills had keys, or whose key was
// ended: asked for with a login, once. It replaces the key the till had.
// A suspended restaurant's till is given one too: its sales must still sync.
// The key stands for the login that asked, so it is given only to one that
// may set up tills: a cashier's login signed in on a till would otherwise
// replace the till's key with one in its own name. Without a key that till
// goes on syncing with its login, as before tills had keys.
app.post("/devices/key", async (c) => {
  let auth: Authed;
  try {
    auth = await requireAuth(c.req.raw);
  } catch (res) {
    return res as Response;
  }
  if (!(await maySetUpTills(auth.employeeId))) return c.json(NOT_FOR_TILLS, 403);
  const body: { deviceId?: string } = await c.req.json<{ deviceId?: string }>().catch((): { deviceId?: string } => ({}));
  const deviceId = body.deviceId ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(deviceId)) return c.json({ error: "deviceId required" }, 400);
  try {
    const k = await pool.query(`select issue_device_key($1::uuid, $2::uuid) as k`, [auth.employeeId, deviceId]);
    await heard(c.req.raw, deviceId, "seen");
    return c.json({ deviceId, syncKey: k.rows[0].k });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("bad-device")) return c.json({ error: "This till is not registered here, or was deactivated." }, 404);
    console.error("key failed:", msg);
    return c.json({ error: "the key could not be made" }, 503);
  }
});

// The tablet is being signed out: its key ends with it. Asked by the till
// with the key itself, or by a login for a till of its own restaurant.
app.delete("/devices/key", async (c) => {
  let auth: Authed;
  try {
    auth = await requireTill(c.req.raw);
  } catch (res) {
    return res as Response;
  }
  let deviceId = auth.deviceId;
  if (!deviceId) {
    const asked = c.req.query("deviceId") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(asked)) return c.json({ error: "deviceId required" }, 400);
    const mine = await pool.query(`select 1 from pos_devices where id = $1::uuid and tenant_id = $2::uuid`, [asked, auth.tenantId]).catch(() => ({ rowCount: 0 }));
    if (mine.rowCount !== 1) return c.json({ error: "This till is not registered here." }, 404);
    deviceId = asked;
  }
  try {
    const out = await pool.query(`select revoke_device_key($1::uuid) as r`, [deviceId]);
    return c.json({ ended: out.rows[0].r === true });
  } catch (err) {
    console.error("ending a key failed:", (err as Error).message);
    return c.json({ error: "the key could not be ended" }, 503);
  }
});

// Push contract for the Android outbox worker (spec 5.4). The employee comes
// from the JWT lookup, never the body. Per-op results always 200; only
// batch-level failures (bad shape, unknown employee) are 4xx.
app.post("/sync/push", async (c) => {
  let auth: Authed;
  try {
    auth = await requireTill(c.req.raw);
  } catch (res) {
    return res as Response;
  }
  if (await tooOldForShop(c.req.raw, auth.tenantId)) return c.json(SHOP_TOO_OLD, 426);
  const body: { ops?: unknown } = await c.req.json<{ ops?: unknown }>().catch((): { ops?: unknown } => ({}));
  if (!Array.isArray(body.ops) || body.ops.length < 1 || body.ops.length > 200) {
    return c.json({ error: "ops must be an array of 1..200" }, 400);
  }
  try {
    const out = await asTenant<{ r: unknown }>(auth.tenantId, (q) =>
      q(`select sync_push($1::uuid, $2::jsonb) as r`, [auth.employeeId, JSON.stringify(body.ops)]).then((r) => r.rows),
    );
    await heard(c.req.raw, auth.deviceId, "push");
    return c.json(out[0].r);
  } catch (err) {
    return c.json({ error: "push failed" }, syncFailure("push", err));
  }
});

// Pull contract for the Android worker and back office (spec 5.5).
app.get("/sync/pull", async (c) => {
  let auth: Authed;
  try {
    auth = await requireTill(c.req.raw);
  } catch (res) {
    return res as Response;
  }
  if (await tooOldForShop(c.req.raw, auth.tenantId)) return c.json(SHOP_TOO_OLD, 426);
  const storeId = c.req.query("storeId") ?? "";
  const cursor = Number(c.req.query("cursor") ?? "0");
  const limit = Number(c.req.query("limit") ?? "200");
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return c.json({ error: "storeId required" }, 400);
  // a till with its key pulls the store it was set up in, and no other
  if (auth.storeId && auth.storeId.toLowerCase() !== storeId.toLowerCase()) return c.json({ error: "a till pulls its own store" }, 400);
  if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit)) return c.json({ error: "cursor and limit must be whole numbers" }, 400);
  try {
    const out = await asTenant<{ r: unknown }>(auth.tenantId, (q) =>
      q(`select sync_pull($1::uuid, $2::bigint, $3::int) as r`, [storeId, cursor, limit]).then((r) => r.rows),
    );
    await heard(c.req.raw, auth.deviceId, "pull");
    return c.json(out[0].r);
  } catch (err) {
    return c.json({ error: "pull failed" }, syncFailure("pull", err));
  }
});

// What a till wrote down when it stopped unexpectedly, sent the next time it
// runs: where in the program, which version, which tablet. At most ten at a
// time, each cut to size by report_crashes; the same report twice is kept once.
app.post("/crash", async (c) => {
  let auth: Authed;
  try {
    auth = await requireTill(c.req.raw);
  } catch (res) {
    return res as Response;
  }
  const body: { reports?: unknown } = await c.req.json<{ reports?: unknown }>().catch((): { reports?: unknown } => ({}));
  if (!Array.isArray(body.reports) || body.reports.length < 1) return c.json({ error: "reports must be a list" }, 400);
  const reports = body.reports.slice(0, 10);
  try {
    const out = await asTenant<{ n: number }>(auth.tenantId, (q) =>
      q(`select report_crashes($1::uuid, $2::jsonb) as n`, [auth.employeeId, JSON.stringify(reports)]).then((r) => r.rows),
    );
    await heard(c.req.raw, auth.deviceId, "seen");
    return c.json({ kept: out[0].n });
  } catch (err) {
    return c.json({ error: "the reports could not be kept" }, syncFailure("crash", err));
  }
});

export default app;
