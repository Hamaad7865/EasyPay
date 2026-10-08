// remove-test-clients.cjs — removes from production the clients that no one
// can use: the ones without a single login. Run by the owner, on purpose:
//
//   node db/remove-test-clients.cjs            lists every client and what would go, changes nothing
//   node db/remove-test-clients.cjs --apply    takes a restore point, asks, then removes them
//
// Why there are any: until 4 October 2026 the project had one database, and the
// test suites ran on it; the dev branch was split off afterwards. Production
// kept the clients those suites made ("dbg", "P2-Probe" and the like).
//
// Why "without a login" is the rule: a client the platform admin makes always
// has its owner's login (platform.create_tenant refuses to make one without),
// and a till is set up under a login. A client with no login cannot be signed
// in to, in the back office or on a till: it is not anyone's. A client with a
// login is never touched, whatever its name.
//
// The back office has no "delete client" on purpose (a client with sales is
// suspended, never deleted: 0044). This is the one-off before the first real
// client, and it is why it takes a restore point first: a Neon branch of
// production as it was, which costs nothing until it is used.
//
// What a client's rows are is not listed here: every table of the public
// schema with a tenant_id column is one, found at run time, so a table added
// by a later migration is not forgotten. The insert-only guards (block_update
// on receipts and the like) are lifted and put back inside the one
// transaction that does it all: it commits whole or not at all.
const { execSync } = require('child_process');
const readline = require('readline');

const PROJECT = 'snowy-fire-89764432';
const BRANCH = 'production';
// the production compute's host begins with this; the dev branch's does not
const HOST = 'ep-soft-poetry';

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

// Every client, oldest first, with what tells a test leftover from a real one.
async function listClients(c) {
  return (await c.query(
    `select t.id, upper(left(t.id::text, 8)) as short, t.name, t.plan, t.status, t.created_at::date::text as made,
            -- any login it ever had, switched off or not
            (select count(*)::int from employees e where e.tenant_id = t.id and e.auth_user_id is not null) as logins,
            (select count(*)::int from pos_devices d where d.tenant_id = t.id) as tills,
            (select count(*)::int from receipts r where r.tenant_id = t.id) as receipts,
            (select max(r.created_at)::date::text from receipts r where r.tenant_id = t.id) as last_sale
       from tenants t order by t.created_at, t.id`)).rows;
}

const withoutLogin = (clients) => clients.filter((x) => x.logins === 0);

// Removes these clients and every row of theirs. No BEGIN or COMMIT here: the
// caller holds the transaction. Returns how many rows went from each table.
async function removeClients(c, ids) {
  if (!ids.length) return {};
  // asked again inside the transaction: a login given a moment ago saves its client
  const used = await c.query(
    `select t.name from tenants t where t.id = any($1::uuid[])
        and exists (select 1 from employees e where e.tenant_id = t.id and e.auth_user_id is not null)`, [ids]);
  if (used.rowCount) throw new Error(`has-login:${used.rows.map((r) => r.name).join(', ')}`);

  const tables = (await c.query(
    `select c.table_name as t from information_schema.columns c
       join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'tenant_id' and b.table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.t);
  const guards = (await c.query(
    `select c.relname as t, g.tgname as g from pg_trigger g
       join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = g.tgfoid
      where n.nspname = 'public' and not g.tgisinternal and p.proname = 'block_update' and c.relname = any($1) order by 1`, [tables])).rows;

  for (const g of guards) await c.query(`alter table public.${q(g.t)} disable trigger ${q(g.g)}`);

  // A table can only be emptied once the tables that point at it are. Rather than
  // keep an order by hand, each round empties what it can and leaves the rest
  // (a foreign key's refusal: 23503, or 23001 from one declared RESTRICT) for the
  // next; a round that empties nothing is an error.
  const gone = {};
  let left = tables;
  while (left.length) {
    const next = [];
    let why = '';
    for (const t of left) {
      await c.query('SAVEPOINT one');
      try {
        gone[t] = (await c.query(`delete from public.${q(t)} where tenant_id = any($1::uuid[])`, [ids])).rowCount;
        await c.query('RELEASE SAVEPOINT one');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT one');
        if (e.code !== '23503' && e.code !== '23001') throw new Error(`${t}: ${e.message}`);
        why = `${t}: ${e.message}`;
        next.push(t);
      }
    }
    if (next.length === left.length) throw new Error(`these could not be emptied: ${next.join(', ')} (${why})`);
    left = next;
  }

  for (const g of guards) await c.query(`alter table public.${q(g.t)} enable trigger ${q(g.g)}`);

  // what would mean it did not do what it says: a client still there, or a row of one
  if (gone.tenants !== ids.length) throw new Error(`${gone.tenants} of ${ids.length} clients were removed: nothing is kept`);
  for (const t of tables) {
    const still = await c.query(`select 1 from public.${q(t)} where tenant_id = any($1::uuid[]) limit 1`, [ids]);
    if (still.rowCount) throw new Error(`${t} still holds rows of a removed client: nothing is kept`);
  }
  return gone;
}

module.exports = { listClients, withoutLogin, removeClients };
if (require.main !== module) return;

// ---- the run ----

const neon = (args) => execSync(`neon ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
});

(async () => {
  const apply = process.argv.includes('--apply');
  const { Client } = require('pg');
  const url = neon(`connection-string ${BRANCH} --project-id ${PROJECT} --role-name neondb_owner`);
  if (!new URL(url).hostname.startsWith(HOST)) throw new Error(`this is not the production host (${new URL(url).hostname.split('.')[0]}): nothing was done`);
  const c = new Client({ connectionString: url, ssl: { require: true } });
  await c.connect();
  try {
    const clients = await listClients(c);
    const going = withoutLogin(clients);
    console.log(`Production has ${clients.length} clients.\n`);
    console.log('          id        made        logins  tills  receipts  last sale   name');
    for (const x of clients) {
      console.log(`  ${x.logins === 0 ? 'REMOVE' : 'keep  '}  ${x.short}  ${x.made}  ${String(x.logins).padStart(6)}  ${String(x.tills).padStart(5)}  ${String(x.receipts).padStart(8)}  ${(x.last_sale || 'never').padEnd(10)}  ${x.name}`);
    }
    console.log(`\n${going.length} have no login and would be removed, with ${going.reduce((n, x) => n + x.receipts, 0)} receipts between them. ${clients.length - going.length} have a login and are kept.`);
    if (!going.length) { console.log('Nothing to remove.'); return; }
    if (!apply) { console.log('Nothing was changed. To remove them: node db/remove-test-clients.cjs --apply'); return; }

    if (!process.stdin.isTTY) throw new Error('run this in a terminal: it asks before it removes anything');
    const said = await ask(`\nRemove these ${going.length} clients from PRODUCTION for good? Type ${going.length} to go on: `);
    if (said !== String(going.length)) { console.log('Nothing was done.'); return; }

    // production as it is now, to go back to
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const restore = `production-before-clean-${stamp}`;
    neon(`branches create --project-id ${PROJECT} --name ${restore} --parent ${BRANCH} --compute false`);
    console.log(`Restore point taken: the Neon branch ${restore}`);

    await c.query('BEGIN');
    let gone;
    try {
      gone = await removeClients(c, going.map((x) => x.id));
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw new Error(`nothing was removed (${e.message})`);
    }
    const rows = Object.values(gone).reduce((n, x) => n + x, 0);
    const from = Object.keys(gone).filter((t) => gone[t] > 0).length;
    console.log(`Removed ${gone.tenants} clients: ${rows} rows from ${from} tables.`);
    console.log(`Production has ${(await listClients(c)).length} clients now.`);
    console.log(`If anything is missed, production as it was is the branch ${restore}; delete that branch once you are sure.`);
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error(`STOPPED: ${String(e.stderr || e.message).replace(/postgres(ql)?:\/\/\S+/g, '***').trim()}`);
  process.exit(1);
});
