import { Client, Pool, type PoolClient, type QueryResult } from "pg";

// Where the back office runs decides how it holds its connections.
//
// On a Node server (next dev, next start) there is one pool for the whole
// server. It is kept on globalThis so the dev server's reloads reuse it
// instead of leaving a pool behind at every change.
//
// A connection takes about seven round trips to open (TCP, TLS, sign-in). It
// used to be closed after ten idle seconds, so most clicks in the back office
// paid for a new one. It is now kept for five minutes; a keep-alive tells the
// two ends when the other has gone.
//
// On Cloudflare Workers (the deployed back office) a connection cannot be
// kept from one request to the next: the platform ties it to the request
// that opened it, and using it from another fails. So there is no pool
// there. Each question opens its own connection and closes it when it has
// its answer; the Worker is placed beside the database, where opening one
// costs little.
//
// `pipeline`: questions put to one connection without waiting for each other
// (a Promise.all of c.query) go out together and their answers come back
// together, one round trip for all of them. The database still answers them
// in the order they were asked, inside the same transaction; code that waits
// for each answer before asking the next is not changed by it.
const g = globalThis as unknown as { __easypayPool?: Pool };

const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

function pool(): Pool {
  if (!g.__easypayPool) {
    const made = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 5 * 60_000, keepAlive: true, pipeline: true });
    // A connection the server closed while it sat idle is dropped by the pool;
    // without a listener that event would stop the whole server.
    made.on("error", () => {});
    g.__easypayPool = made;
  }
  return g.__easypayPool;
}

// One connection of its own, for one question or one transaction (Workers).
async function own(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL, pipeline: true });
  // a connection the database drops must not take the request down with it
  client.on("error", () => {});
  await client.connect();
  return client;
}
const shut = (client: Client) => client.end().catch(() => {});

// What asks a question outside a restaurant's transaction: the pool itself on
// a Node server, and on Workers something that opens a connection for each.
type Asker = { query: (sql: string, params?: unknown[]) => Promise<QueryResult> };

const perQuestion: Asker = {
  async query(sql, params = []) {
    const client = await own();
    try {
      return await client.query(sql, params);
    } finally {
      await shut(client);
    }
  },
};

export function db(): Asker {
  return onWorkers ? perQuestion : pool();
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

// A connection held for one transaction, and how it is given back: to the
// pool on a Node server (dropped instead if it broke), closed on Workers.
type Held = { client: PoolClient; done: (broken?: boolean) => Promise<void> };

async function take(): Promise<Held> {
  if (onWorkers) {
    const client = await own();
    // the pages take a pool's client; one of its own asks the same questions the same way
    return { client: client as unknown as PoolClient, done: () => shut(client) };
  }
  const client = await pool().connect();
  return {
    client,
    done: async (broken) => {
      client.release(broken);
    },
  };
}

// A connection with the restaurant's transaction open on it. BEGIN, the role
// and the tenant go in ONE round trip instead of three: they are sent together
// as plain text, which takes no bind parameters, so the tenant id is written
// into the statement, and only ever as the uuid it is checked to be.
async function begin(tenantId: string, readOnly: boolean): Promise<Held> {
  if (!UUID.test(tenantId)) throw new Error("Not a tenant id.");
  const opening = `BEGIN${readOnly ? " READ ONLY" : ""}; SET LOCAL ROLE app_user; SELECT set_config('app.tenant_id', '${tenantId}', true)`;
  for (let attempt = 0; ; attempt++) {
    const held = await take();
    try {
      await held.client.query(opening);
      return held;
    } catch (e) {
      await held.done(true);
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
  const held = await begin(tenantId, false);
  try {
    const out = await fn(held.client);
    await held.client.query("COMMIT");
    await held.done();
    return out;
  } catch (e) {
    try {
      await held.client.query("ROLLBACK");
      await held.done();
    } catch {
      await held.done(true);
    }
    throw e;
  }
}

// The same for a page that only READS. The transaction is read-only, so the
// database itself refuses a write slipped in here, and since nothing was
// written there is nothing to wait for at the end: on a Node server the page
// gets its rows and the transaction is closed behind it, a round trip sooner.
// On Workers nothing may be left running once the answer has gone out, so
// the close is waited for there.
export async function readTenant<T>(
  tenantId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const held = await begin(tenantId, true);
  const end = (how: "COMMIT" | "ROLLBACK") =>
    held.client.query(how).then(
      () => held.done(),
      () => held.done(true),
    );
  try {
    const out = await fn(held.client);
    const closing = end("COMMIT");
    if (onWorkers) await closing;
    return out;
  } catch (e) {
    const closing = end("ROLLBACK");
    if (onWorkers) await closing;
    throw e;
  }
}
