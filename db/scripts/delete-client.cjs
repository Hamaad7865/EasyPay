// delete-client.cjs — removes a client for good: its stores, tills, items,
// sales, stock and everything else it has. /admin has no such thing on
// purpose (a client that stops is suspended and keeps its books); this is for
// a client that should never have been there, like one made to try things.
// Run by a person, on purpose:
//
//   node db/scripts/delete-client.cjs 7BAFE3B9 "Hamaad Retail"            rehearses it, then puts everything back
//   node db/scripts/delete-client.cjs 7BAFE3B9 "Hamaad Retail" --apply    deletes it
//   node db/scripts/delete-client.cjs 7BAFE3B9 "Hamaad Retail" E08F5EE2 "Test"   several, one after another
//   ... --dev                                                             the dev branch of .env.local, not production
//
// A client is named twice: the eight characters under its name on /admin, and
// its name as written there. Both must be one and the same client or nothing
// is done, so a slip of the finger cannot reach another one.
//
// Without --apply nothing is changed, and it is not a guess either: every row
// is really deleted inside one transaction, what is left is counted, and the
// transaction is rolled back. So what --apply will do has been done once
// already. Before either ends it checks that nothing of the client is left in
// any table that has a tenant_id, that no other client lost a row, and that
// the guards it lifted are back.
//
// The guards: a sale, a delivery, a received order and a closed stock count
// cannot be changed or deleted (trg_no_update, trg_draft_only,
// trg_open_only). They are switched off on the tables this client has rows
// in, for the length of the one transaction, which holds those tables against
// other writers until it ends: under a second.
//
// What it leaves:
// - the client's logins, in the sign-in service, belonging to nobody. Such a
//   login opens nothing; "New client" on /admin takes one over with a new
//   password when its e-mail is typed there.
// - what was done to the client on /admin (platform.audit), which is a log.
// - a tablet set up for the client: it is refused from then on, and is set up
//   again for another client after its EasyPay data is cleared.
//
// Production's connection comes from the Neon CLI (already signed in on this
// PC), as in db/migrate-production.cjs; it is never printed and never written
// to a file. There is no way back from --apply but a restore point made first:
//   neon branches create --project-id snowy-fire-89764432 --name production-before-delete-clients --parent production --compute false
const { Client } = require('pg');
// which database (production, or --dev) and which client: shared with seed-demo-client.cjs
const { connection, clientOf, pairsOf } = require('./connection.cjs');

const GUARDS = ['trg_no_update', 'trg_draft_only', 'trg_open_only'];

const quoted = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const lit = (text) => "'" + String(text).replace(/'/g, "''") + "'";

// One client, in one transaction. Returns what it had. Throws, having changed
// nothing, when anything is not as expected.
async function remove(c, short, name, apply) {
  const rows = async (sql, args) => (await c.query(sql, args)).rows;
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await c.query(`set local lock_timeout = '8s'`);
    await c.query(`set local statement_timeout = '120s'`);
    const t = await clientOf(c, short, name);

    const tables = (await rows(
      `select c.table_name as t from information_schema.columns c
         join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'tenant_id' and b.table_type = 'BASE TABLE' and c.table_name <> 'tenants'
        order by 1`)).map((r) => r.t);
    // every table in one question, not one each: after the deleting, the tables are held while this is asked
    const count = async () => {
      const out = {};
      const each = tables.map((tbl) =>
        `select ${lit(tbl)} as t, count(*) filter (where tenant_id = $1)::int as mine, count(*) filter (where tenant_id <> $1)::int as others from ${quoted(tbl)}`);
      for (const r of await rows(each.join(' union all '), [t.id])) out[r.t] = { mine: r.mine, others: r.others };
      return out;
    };
    const before = await count();
    const clients = (await rows(`select count(*)::int as n from tenants`))[0].n;
    const logins = (await rows(`select count(*)::int as n from employees where tenant_id = $1 and auth_user_id is not null`, [t.id]))[0].n;
    const has = tables.filter((tbl) => before[tbl].mine > 0);

    const guards = await rows(
      `select c.relname as t, g.tgname as g from pg_trigger g
         join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where not g.tgisinternal and n.nspname = 'public' and g.tgname = any($1) and c.relname = any($2) order by 1, 2`, [GUARDS, has]);
    // The guards off, the rows deleted, the guards on: one block, run by the
    // server in one go, so the tables are held for as long as the deleting
    // takes and no longer. Children before what they hang from, without being
    // told the order: a table that something still points at is tried again
    // after the others.
    if (!/^[0-9a-f-]{36}$/.test(t.id)) throw new Error('the client has an ID that is not one');
    await c.query(`do $do$
declare
  v_tenant uuid := ${lit(t.id)};
  v_left text[] := array[${has.map(lit).join(', ')}]::text[];
  v_again text[];
  v_table text;
  v_why text;
  v_gone int;
begin
  ${guards.map((g) => `alter table ${quoted(g.t)} disable trigger ${quoted(g.g)};`).join(' ')}
  while coalesce(array_length(v_left, 1), 0) > 0 loop
    v_again := '{}';
    foreach v_table in array v_left loop
      begin
        execute format('delete from %I where tenant_id = $1', v_table) using v_tenant;
      exception when foreign_key_violation or restrict_violation then
        v_again := v_again || v_table;
        get stacked diagnostics v_why = message_text;
      end;
    end loop;
    if array_length(v_again, 1) = array_length(v_left, 1) then
      raise exception 'these still have something pointing at them: % (%)', array_to_string(v_again, ', '), v_why;
    end if;
    v_left := v_again;
  end loop;
  delete from tenants where id = v_tenant;
  get diagnostics v_gone = row_count;
  if v_gone <> 1 then
    raise exception 'the client''s own row: % deleted, 1 expected', v_gone;
  end if;
  ${guards.map((g) => `alter table ${quoted(g.t)} enable trigger ${quoted(g.g)};`).join(' ')}
end
$do$`);

    const after = await count();
    const kept = tables.filter((tbl) => after[tbl].mine !== 0);
    if (kept.length) throw new Error(`rows of the client are left in ${kept.join(', ')}`);
    const lost = tables.filter((tbl) => after[tbl].others !== before[tbl].others);
    if (lost.length) throw new Error(`another client's rows changed in ${lost.join(', ')}`);
    const now = (await rows(`select count(*)::int as n from tenants`))[0].n;
    if (now !== clients - 1) throw new Error(`${clients} clients before and ${now} after: one fewer expected`);
    const off = await rows(
      `select c.relname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where not g.tgisinternal and n.nspname = 'public' and g.tgname = any($1) and g.tgenabled = 'D'`, [GUARDS]);
    if (off.length) throw new Error(`a guard is still off on ${off.map((r) => r.t).join(', ')}`);

    await c.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { client: t, had: has.map((tbl) => [tbl, before[tbl].mine]), tables: tables.length, guards: guards.length, logins, others: clients - 1 };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* the connection is gone: nothing was committed */ }
    throw e;
  }
}

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dev = args.includes('--dev');
  const strange = args.filter((a) => a.startsWith('--') && a !== '--apply' && a !== '--dev');
  const named = args.filter((a) => !a.startsWith('--'));
  if (strange.length) throw new Error(`${strange.join(' ')} is not something this takes: nothing was done`);
  const pairs = pairsOf(named, 'delete-client.cjs');

  const { url, where } = connection(dev);
  const c = new Client({ connectionString: url, ssl: { require: true } });
  await c.connect();
  let done = 0;
  try {
    for (const [short, name] of pairs) {
      const r = await remove(c, short, name, apply);
      done++;
      const t = r.client;
      console.log(`${where}: ${t.name} (${short.toUpperCase()}), ${t.business_type}, ${t.plan}, ${t.status}, made ${t.made}.`);
      console.log(r.had.length ? r.had.map(([tbl, n]) => `  ${String(n).padStart(7)}  ${tbl}`).join('\n') : '  it has nothing but its own row');
      console.log(`${apply ? 'Deleted' : 'Rehearsed'}: nothing of it is left in ${r.tables} tables, the other ${r.others} client${r.others === 1 ? '' : 's'} lost nothing, ${r.guards} guard${r.guards === 1 ? '' : 's'} lifted and put back.`);
      if (r.logins) console.log(`${r.logins} login${r.logins === 1 ? '' : 's'} of it ${apply ? 'stay' : 'would stay'} in the sign-in service, belonging to nobody.`);
      console.log(apply ? '' : 'Everything was put back: nothing was changed.\n');
    }
  } catch (e) {
    throw new Error(`${e.message}: ${done && apply ? `stopped here. ${done} client${done === 1 ? ' was' : 's were'} deleted before this one, as said above; this one was not touched` : 'nothing was done'}`);
  } finally {
    await c.end();
  }
  if (!apply) console.log('To delete for good: the same command with --apply at the end.');
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
