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

type Authed = { authUserId: string; tenantId: string; employeeId: string; status: string };

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

const SUSPENDED = { error: "This account is suspended. Sales already made still sync; contact RestoPOS to reactivate." };
function suspended(auth: Authed): boolean {
  return auth.status !== "active";
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

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, branch: process.env.NEON_BRANCH ?? "unknown", build: "admin-0046" }));

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
      return c.json({ error: "This till was deactivated. Contact RestoPOS to reactivate it." }, 403);
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
    return c.json({ deviceId: rows[0].id, lastReceiptSeq: Number(rows[0].last_receipt_seq) });
  } catch (err) {
    const msg = (err as Error).message;
    console.error("register failed:", msg);
    if (msg.includes("pos_devices_tenant_id_store_id_code_key")) {
      return c.json({ error: "device code already registered in this store" }, 409);
    }
    return c.json({ error: "register failed" }, 400);
  }
});

// Push contract for the Android outbox worker (spec 5.4). The employee comes
// from the JWT lookup, never the body. Per-op results always 200; only
// batch-level failures (bad shape, unknown employee) are 4xx.
app.post("/sync/push", async (c) => {
  let auth: Authed;
  try {
    auth = await requireAuth(c.req.raw);
  } catch (res) {
    return res as Response;
  }
  const body: { ops?: unknown } = await c.req.json<{ ops?: unknown }>().catch((): { ops?: unknown } => ({}));
  if (!Array.isArray(body.ops) || body.ops.length < 1 || body.ops.length > 200) {
    return c.json({ error: "ops must be an array of 1..200" }, 400);
  }
  try {
    const out = await asTenant<{ r: unknown }>(auth.tenantId, (q) =>
      q(`select sync_push($1::uuid, $2::jsonb) as r`, [auth.employeeId, JSON.stringify(body.ops)]).then((r) => r.rows),
    );
    return c.json(out[0].r);
  } catch (err) {
    console.error("push failed:", (err as Error).message);
    return c.json({ error: "push failed" }, 400);
  }
});

// Pull contract for the Android worker and back office (spec 5.5).
app.get("/sync/pull", async (c) => {
  let auth: Authed;
  try {
    auth = await requireAuth(c.req.raw);
  } catch (res) {
    return res as Response;
  }
  const storeId = c.req.query("storeId") ?? "";
  const cursor = Number(c.req.query("cursor") ?? "0");
  const limit = Number(c.req.query("limit") ?? "200");
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return c.json({ error: "storeId required" }, 400);
  try {
    const out = await asTenant<{ r: unknown }>(auth.tenantId, (q) =>
      q(`select sync_pull($1::uuid, $2::bigint, $3::int) as r`, [storeId, cursor, limit]).then((r) => r.rows),
    );
    return c.json(out[0].r);
  } catch (err) {
    console.error("pull failed:", (err as Error).message);
    return c.json({ error: "pull failed" }, 400);
  }
});

export default app;
