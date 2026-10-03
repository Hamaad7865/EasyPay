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
async function step(name, fn) {
  try { await fn(); } catch (e) { console.log('STEPFAIL ' + name + ': ' + e.message); throw e; }
}
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
  const devT = (await c.query(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).rows[0].id;

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
  check('T1 replay keeps original status + replayed flag',
    r2[0].status === 'rejected' && r2[0].code === r1[0].code && r2[0].replayed === true, JSON.stringify(r2[0]));

  // T2: applied replay keeps ORIGINAL applied status
  const tk = crypto.randomUUID();
  const good = [op('ticket.create', { id: tk, store_id: store })];
  const g1 = await pushRaw(good);
  check('T2 first: applied', g1[0].status === 'applied');
  const g2 = await pushRaw(good);
  check('T2 replay keeps original applied status + replayed flag',
    g2[0].status === 'applied' && g2[0].replayed === true, JSON.stringify(g2[0]));

  // T3: unexpected system error persists as rejected/'error' with server detail,
  // and the batch CONTINUES past it (only transients stop the batch)
  const tk3 = crypto.randomUUID();
  const sysId = crypto.randomUUID();
  const afterId = crypto.randomUUID();
  const sys = [op('ticket.create', { id: tk3, store_id: store }),
    { op_id: sysId, type: 'ticket.add_line', payload: { id: crypto.randomUUID(), ticket_id: tk, item_id: crypto.randomUUID(), qty: 99999999999 } },
    op('ticket.create', { id: afterId, store_id: store })];
  await step('T3-push', async () => { r = await pushRaw(sys); });
  check('T3 unexpected persists as error, batch continues',
    r[0].status === 'applied' && r[1].status === 'rejected' && r[1].code === 'error' && r[2].status === 'applied',
    JSON.stringify(r.map((o) => o.status + ':' + (o.code || ''))));
  const logged = (await c.query(`select result from sync_ops_applied where op_id='${sysId}'`)).rows;
  check('T3 error row persisted', logged.length === 1 && logged[0].result.code === 'error');

  // T4: lock contention (55P03) stops the batch with retry envelopes.
  // Holder session keeps the ticket lock open; pusher session has a lock
  // timeout backstop so the pre-fix blocking lock cannot hang the suite.
  const tk4 = crypto.randomUUID();
  await step('T4-setup', async () => { await pushRaw([op('ticket.create', { id: tk4, store_id: store })]); });
  const rB = { op_id: crypto.randomUUID(), type: 'receipt.create',
    payload: { id: crypto.randomUUID(), ticket_id: tk4, store_id: store, device_id: devT, number: 'PP-T4', device_seq: 1, payments: [] } };
  const rC = op('ticket.create', { id: crypto.randomUUID(), store_id: store });
  await c.query('BEGIN');
  await c.query('SET ROLE app_user');
  await c.query(`SET LOCAL app.tenant_id = '${tid}'`);
  await c.query(`select pg_advisory_xact_lock(hashtextextended('receipt:' || '${tk4}', 0))`);
  const { Client: Client2 } = require('pg');
  const strip = (v) => { v = String(v).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  const c2 = new Client2({ connectionString: strip(process.env.DATABASE_URL_UNPOOLED || loadEnv('.env.local').DATABASE_URL_UNPOOLED), ssl: { require: true } });
  await c2.connect();
  await c2.query('BEGIN');
  await c2.query('SET ROLE app_user');
  await c2.query(`SET LOCAL app.tenant_id = '${tid}'`);
  await c2.query(`SET LOCAL lock_timeout = '3s'`);
  const empRow = (await c.query(`select id from employees where tenant_id='${tid}' limit 1`)).rows[0].id;
  let r4;
  await step('T4-push', async () => {
    r4 = (await c2.query('select sync_push($1, $2::jsonb) as r', [empRow, JSON.stringify([rB, rC])])).rows[0].r;
  });
  await c2.query('COMMIT');
  await c2.query('RESET ROLE');
  await c2.end();
  await c.query('COMMIT');
  await c.query('RESET ROLE');
  check('T4 contention stops batch with retry',
    r4[0].status === 'retry' && r4[1].status === 'retry', JSON.stringify(r4));
  const t4logged = (await c.query(`select count(*)::int n from sync_ops_applied where op_id in ('${rB.op_id}','${rC.op_id}')`)).rows[0].n;
  check('T4 transient persists nothing', t4logged === 0, 'n=' + t4logged);

  // T5: genuine business rejections keep their own codes (not 'error')
  const tk5 = crypto.randomUUID();
  await step('T5-push', async () => { r = await pushRaw([
    op('ticket.create', { id: tk5, store_id: store }),
    op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk5, item_id: crypto.randomUUID(), qty: 1000 }),
  ]); });
  check('T5 unknown-item keeps its code', r[1].status === 'rejected' && r[1].code === 'unknown-item', JSON.stringify(r[1]));

  await c.query(`alter table sync_ops_applied disable trigger trg_no_update`);
  // children before parents: composite FKs are RESTRICT since 0019
  for (const t of ['sync_ops_applied','tickets','pos_devices','stores','employees','roles','tenants'])
    await c.query(`delete from ${t} where tenant_id='${tid}'`);
  await c.query(`alter table sync_ops_applied enable trigger trg_no_update`);
  console.log(failures === 0 ? 'PUSH-POLICY PASS' : `PUSH-POLICY FAIL (${failures})`);
  await c.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
