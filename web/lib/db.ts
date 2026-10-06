import { Pool, type PoolClient } from "pg";

// One pool for the whole server. It is kept on globalThis so the dev server's
// reloads reuse it instead of leaving a pool behind at every change.
//
// A connection takes about seven round trips to open (TCP, TLS, sign-in). It
// used to be closed after ten idle seconds, so most clicks in the back office
// paid for a new one. It is now kept for five minutes; a keep-alive tells the
// two ends when the other has gone.
const g = globalThis as unknown as { __easypayPool?: Pool };

export function db() {
  if (!g.__easypayPool) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 5 * 60_000, keepAlive: true });
    // A connection the server closed while it sat idle is dropped by the pool;
    // without a listener that event would stop the whole server.
    pool.on("error", () => {});
    g.__easypayPool = pool;
  }
  return g.__easypayPool;
}

// The connection was gone (closed by the database while idle, or the network
// dropped): nothing was run on it, so the same thing can be tried on a new one.
function gone(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  const msg = err?.message ?? "";
  return (
    ["ECONNRESET", "EPIPE", "ETIMEDOUT", "57P01", "57P02", "57P03", "08003", "08006"].includes(err?.code ?? "") ||
    /Connection terminated|connection is closed|Client has encountered a connection error|terminating connection/i.test(msg)
  );
}

// One query outside a restaurant's transaction (the sign-in lookups).
export async function ask(sql: string, params: unknown[] = []) {
  try {
    return await db().query(sql, params);
  } catch (e) {
    if (!gone(e)) throw e;
    return await db().query(sql, params);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A connection with the restaurant's transaction open on it. BEGIN, the role
// and the tenant go in ONE round trip instead of three: they are sent together
// as plain text, which takes no bind parameters, so the tenant id is written
// into the statement, and only ever as the uuid it is checked to be.
async function begin(tenantId: string, readOnly: boolean): Promise<PoolClient> {
  if (!UUID.test(tenantId)) throw new Error("Not a tenant id.");
  const opening = `BEGIN${readOnly ? " READ ONLY" : ""}; SET LOCAL ROLE app_user; SELECT set_config('app.tenant_id', '${tenantId}', true)`;
  for (let attempt = 0; ; attempt++) {
    const client = await db().connect();
    try {
      await client.query(opening);
      return client;
    } catch (e) {
      client.release(true);
      if (attempt > 0 || !gone(e)) throw e;
    }
  }
}

// Tenant-stamped transaction: least-privilege role + GUC (spec 4.2.3).
// Callers pass tenantId from the session lookup, never from the client.
// One explicit transaction: SET LOCAL only lives inside a txn block, and a
// throw in fn rolls everything back. SET LOCAL ROLE needs no RESET.
// This is the one for anything that WRITES: it waits for the COMMIT, so
// "saved" is only said once it is.
export async function withTenant<T>(
  tenantId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await begin(tenantId, false);
  try {
    const out = await fn(client);
    await client.query("COMMIT");
    client.release();
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch {
      client.release(true);
    }
    throw e;
  }
}

// The same for a page that only READS. The transaction is read-only, so the
// database itself refuses a write slipped in here, and since nothing was
// written there is nothing to wait for at the end: the page gets its rows and
// the transaction is closed behind it, a round trip sooner.
export async function readTenant<T>(
  tenantId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await begin(tenantId, true);
  const end = (how: "COMMIT" | "ROLLBACK") => {
    client.query(how).then(
      () => client.release(),
      () => client.release(true),
    );
  };
  try {
    const out = await fn(client);
    end("COMMIT");
    return out;
  } catch (e) {
    end("ROLLBACK");
    throw e;
  }
}
