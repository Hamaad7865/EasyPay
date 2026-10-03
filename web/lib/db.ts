import { Pool, type PoolClient } from "pg";

let pool: Pool | null = null;

export function db() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
  return pool;
}

// Tenant-stamped transaction: least-privilege role + GUC (spec 4.2.3).
// Callers pass tenantId from the session lookup, never from the client.
// One explicit transaction: SET LOCAL only lives inside a txn block, SET
// takes no bind parameters (so the GUC goes through set_config()), and a
// throw in fn rolls everything back. SET LOCAL ROLE needs no RESET.
export async function withTenant<T>(
  tenantId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* already closed */
    }
    throw e;
  } finally {
    client.release();
  }
}
