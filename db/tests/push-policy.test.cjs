// push-policy.test.cjs — Item 2: only known business codes persist as
// rejections (unexpected errors re-raise, nothing persisted); replay returns
// the ORIGINAL envelope (applied stays applied, rejected stays rejected).
const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
function loadEnv(file) {
  const env = {};
  const strip = (v) => { v = v.trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('='); env[t.slice(0, i).trim()] = strip(t.slice(i + 1));
  }
  return env;
}
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload, op_id) => ({ op_id: op_id || crypto.randomUUID(), type, payload });
(async () => {
  const env = loadEnv('.env.local');
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','PP-Probe')`);
  await c.query(`insert into stores (tenant_id, name, code) values ('${tid}','Main','PPS1')`);
  const store = (await c.query(`select id from stores where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into roles (tenant_id, name, permissions) values ('${tid}','Owner','["*"]')`);
  const role = (await c.query(`select id from roles where tenant_id='${tid}'`)).rows[0].id;
  await c.query(`insert into employees (tenant_id, name, role_id) values ('${tid}','B','${role}')`);
  const emp = (await c.query(`select id from employees where tenant_id='${tid}'`)).rows[0].id;

  async function pushRaw(ops, commit = true) {
    await c.query('BEGIN');
    await c.query('SET ROLE app_user');
    await c.query(`SET LOCAL app.tenant_id = '${tid}'`);
    let out, threw = null;
    try {
      const r = await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)]);
      out = r.rows[0].r;
    } catch (e) { threw = e; }
    await c.query(commit && !threw ? 'COMMIT' : 'ROLLBACK');
    await c.query('RESET ROLE');
    if (threw) throw threw;
    return out;
  }

  // T1: business rejection replay keeps ORIGINAL status+code
  const badId = crypto.randomUUID();
  const bad = [op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: crypto.randomUUID(), item_id: crypto.randomUUID(), qty: 1000 }, badId)];
  let r1 = await pushRaw(bad);
  check('T1 first: rejected/bad-item', r1[0].status === 'rejected', JSON.stringify(r1[0]));
  let r2 = await pushRaw(bad);
  check('T1 replay keeps original rejected status', r2[0].status === 'rejected' && r2[0].code === r1[0].code, JSON.stringify(r2[0]));

  // T2: applied replay keeps ORIGINAL applied status
  const tk = crypto.randomUUID();
  const good = [op('ticket.create', { id: tk, store_id: store })];
  const g1 = await pushRaw(good);
  check('T2 first: applied', g1[0].status === 'applied');
  const g2 = await pushRaw(good);
  check('T2 replay keeps original applied status', g2[0].status === 'applied', JSON.stringify(g2[0]));

  // T3: unexpected system error re-raises, persists nothing
  const tk3 = crypto.randomUUID();
  const sysId = crypto.randomUUID();
  const sys = [op('ticket.create', { id: tk3, store_id: store }),
    { op_id: sysId, type: 'ticket.add_line', payload: { id: crypto.randomUUID(), ticket_id: tk, item_id: crypto.randomUUID(), qty: 99999999999 } }];
  let raised = null;
  try { await pushRaw(sys); } catch (e) { raised = e; }
  check('T3 unexpected error re-raised', raised !== null && !/bad-|unknown|conflict|forbidden|overpayment|lines-required|empty-ticket|already-refunded/.test(raised.message), raised && raised.message);
  const logged = (await c.query(`select result from sync_ops_applied where op_id='${sysId}'`)).rows;
  check('T3 nothing persisted for unexpected error', logged.length === 0, JSON.stringify(logged));
  const rolledBack = (await c.query(`select count(*)::int n from tickets where id='${tk3}'`)).rows[0].n;
  check('T3 batch rolled back with the raise', rolledBack === 0, 'n=' + rolledBack);

  await c.query(`alter table sync_ops_applied disable trigger trg_no_update`);
  // children before parents: composite FKs are RESTRICT since 0019
  for (const t of ['sync_ops_applied','tickets','stores','employees','roles','tenants'])
    await c.query(`delete from ${t} where tenant_id='${tid}'`);
  await c.query(`alter table sync_ops_applied enable trigger trg_no_update`);
  console.log(failures === 0 ? 'PUSH-POLICY PASS' : `PUSH-POLICY FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
