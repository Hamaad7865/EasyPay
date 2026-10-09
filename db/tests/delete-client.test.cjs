// delete-client.test.cjs — db/scripts/delete-client.cjs: a client removed for
// good. Run here against the dev branch (--dev), on a client made for it:
// the rehearsal changes nothing, a client named wrongly is not touched, the
// real thing leaves no row of the client in any table and no other client
// short of one, and what guards a sale from being deleted is back afterwards.
// Usage: node db/tests/delete-client.test.cjs
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

const ROOT = path.join(__dirname, '..', '..');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const short = tid.slice(0, 8).toUpperCase();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  const fails = async (sql, args) => { try { await c.query(sql, args); return null; } catch (e) { return e.message; } };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'db', 'scripts', 'delete-client.cjs'), '--dev', ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, out: r.stdout || '', err: (r.stderr || '').split('\n').filter((l) => l.startsWith('STOPPED')).join(' ') };
  };
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','DeleteClient-Probe'), ('${other}','${other}','DeleteClient-Other')`);
  try {
    // a client with something in it: a store and its till, a login, an item in
    // a category (the category is deleted after what points at it), and an op
    // it has pushed (which cannot be deleted: sync_ops_applied is guarded)
    for (const [t, code] of [[tid, 'DCS1'], [other, 'DCS2']]) {
      const store = (await q1(`insert into stores (tenant_id, name, code) values ($1,'Main',$2) returning id`, [t, code])).id;
      await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1')`, [t, store]);
      const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [t])).id;
      await c.query(`insert into employees (tenant_id, name, role_id, auth_user_id) values ($1,'Owner',$2,$3)`, [t, role, crypto.randomUUID()]);
      const category = (await q1(`insert into categories (tenant_id, name) values ($1,'Clothing') returning id`, [t])).id;
      await c.query(`insert into items (tenant_id, name, price, category_id) values ($1,'Shirt',10000,$2)`, [t, category]);
      await c.query(`insert into sync_ops_applied (op_id, tenant_id, type) values (gen_random_uuid(), $1, 'probe')`, [t]);
    }
    const tables = (await c.query(
      `select c.table_name as t from information_schema.columns c
         join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'tenant_id' and b.table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.t);
    // every row a client has, in every table that has a tenant_id
    const rowsOf = async (t) => {
      let n = 0;
      for (const table of tables) n += (await q1(`select count(*)::int as n from "${table}" where tenant_id = $1`, [t])).n;
      return n;
    };
    const had = await rowsOf(tid);
    const theirs = await rowsOf(other);
    check('D0 the client made for this has rows in several tables', had >= 8 && theirs === had, had + ' ' + theirs);

    // D1 the rehearsal
    const tried = run(short, 'DeleteClient-Probe');
    check('D1 without --apply it says what the client has and that nothing was changed', tried.code === 0 && /Rehearsed/.test(tried.out) && /nothing was changed/.test(tried.out) && /sync_ops_applied/.test(tried.out) && /1 login/.test(tried.out), tried.code + ' ' + tried.err);
    check('D1 and nothing was', (await rowsOf(tid)) === had && (await rowsOf(other)) === theirs);

    // D2 a client named wrongly
    const wrongName = run(short, 'DeleteClient-Other', '--apply');
    const wrongCase = run(short, 'deleteclient-probe', '--apply');
    const noName = run(short, '--apply');
    const noSuch = run('00000000', 'DeleteClient-Probe', '--apply');
    check('D2 an ID with another client\'s name, a name spelt otherwise, no name, an ID nobody has: refused', [wrongName, wrongCase, noName, noSuch].every((r) => r.code === 1 && /nothing was done/.test(r.err)), [wrongName, wrongCase, noName, noSuch].map((r) => r.code).join(' '));
    check('D2 and nothing was', (await rowsOf(tid)) === had && (await rowsOf(other)) === theirs);

    // D3 the real thing
    const done = run(short, 'DeleteClient-Probe', '--apply');
    check('D3 with --apply it is deleted', done.code === 0 && /Deleted/.test(done.out), done.code + ' ' + done.err);
    check('D3 no row of it is left in any table', (await rowsOf(tid)) === 0, String(await rowsOf(tid)));
    check('D3 the other client has every row it had', (await rowsOf(other)) === theirs, String(await rowsOf(other)));

    // D4 what was lifted is back
    const guarded = await fails(`delete from sync_ops_applied where tenant_id = $1`, [other]);
    check('D4 an op another client pushed still cannot be deleted', !!guarded, String(guarded).slice(0, 80));
    const off = (await q1(`select count(*)::int as n from pg_trigger where not tgisinternal and tgenabled = 'D' and tgname in ('trg_no_update','trg_draft_only','trg_open_only')`)).n;
    check('D4 no guard is left switched off', off === 0, String(off));

    // D5 asked again
    const again = run(short, 'DeleteClient-Probe', '--apply');
    check('D5 asked again, there is no such client and nothing is done', again.code === 1 && /no client has the ID/.test(again.err), again.code + ' ' + again.err.slice(0, 90));
  } finally {
    await devguard.cleanupTenant(c, tid);
    await devguard.cleanupTenant(c, other);
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
