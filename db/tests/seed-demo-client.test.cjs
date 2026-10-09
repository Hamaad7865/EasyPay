// seed-demo-client.test.cjs — db/scripts/seed-demo-client.cjs: a client made
// to be shown to customers, filled with a made-up business. Run here against
// the dev branch (--dev), on a restaurant and a shop made for it the way
// /admin makes one: the rehearsal changes nothing, a client named wrongly is
// not touched, the real thing leaves a menu or a shop, staff whose PINs are
// the ones it says, customers, and days of sales the server worked out itself
// with none flagged, and a client that has something is not filled twice.
// Usage: node db/tests/seed-demo-client.test.cjs
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

const ROOT = path.join(__dirname, '..', '..');
const DAYS = 6;
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  const run = (...args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'db', 'scripts', 'seed-demo-client.cjs'), '--dev', '--days', String(DAYS), ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: r.status, out: r.stdout || '', err: (r.stderr || '').split('\n').filter((l) => l.startsWith('STOPPED')).join(' ') };
  };
  const admin = crypto.randomUUID();
  await c.query(`insert into platform.admins (auth_user_id, email) values ($1, $2)`, [admin, `test-admin-${admin}@example.com`]);
  const make = async (name, code, plan, type) =>
    (await q1(`select platform.create_tenant_of_type($1, $2, 'Main store', $3, 'Owner', $4, $5, $6) as r`, [admin, name, code, crypto.randomUUID(), plan, type])).r.tenant_id;
  const resto = await make('SeedDemo-Resto', 'SDR1', 'premium', 'restaurant');
  const store = await make('SeedDemo-Shop', 'SDS1', 'standard', 'retail');
  const short = (id) => id.slice(0, 8).toUpperCase();
  try {
    const has = (t) => q1(
      `select (select count(*)::int from items where tenant_id = $1) as items, (select count(*)::int from receipts where tenant_id = $1) as receipts,
              (select count(*)::int from employees where tenant_id = $1) as staff, (select count(*)::int from pos_devices where tenant_id = $1) as tills`, [t]);

    // S1 the rehearsal
    const tried = run(short(resto), 'SeedDemo-Resto', short(store), 'SeedDemo-Shop');
    check('S1 without --apply it says what each would be given and that nothing was changed', tried.code === 0 && (tried.out.match(/Rehearsed/g) || []).length === 2 && /nothing was changed/.test(tried.out) && !/PINs/.test(tried.out), tried.code + ' ' + tried.err);
    const r0 = await has(resto), s0 = await has(store);
    check('S1 and nothing was', r0.items === 0 && r0.receipts === 0 && r0.staff === 1 && r0.tills === 0 && s0.items === 0 && s0.receipts === 0, JSON.stringify([r0, s0]));
    const figures = (out) => (out.match(/\d+ sales over \d+ days[^,]*, Rs [\d,]+ taken/g) || []).join(' | ');

    // S2 a client named wrongly
    const wrong = run(short(resto), 'SeedDemo-Shop', '--apply');
    check('S2 an ID with another client\'s name is refused and nothing is done', wrong.code === 1 && /nothing was done/.test(wrong.err) && (await has(resto)).items === 0, wrong.code + ' ' + wrong.err.slice(0, 80));

    // S3 the real thing
    const done = run(short(resto), 'SeedDemo-Resto', short(store), 'SeedDemo-Shop', '--apply');
    check('S3 with --apply both are filled', done.code === 0 && (done.out.match(/Done:/g) || []).length === 2, done.code + ' ' + done.err);
    check('S3 with the sales the rehearsal said', figures(done.out) !== '' && figures(done.out) === figures(tried.out), figures(done.out));
    for (const [label, t, items] of [['restaurant', resto, 43], ['shop', store, 32]]) {
      const g = await q1(
        `select (select count(*)::int from items where tenant_id = $1) as items,
                (select count(*)::int from tables where tenant_id = $1) as tables,
                (select count(*)::int from employees where tenant_id = $1 and pin_hash is not null and auth_user_id is null) as staff,
                (select count(*)::int from customers where tenant_id = $1) as customers,
                (select count(*)::int from receipts where tenant_id = $1) as receipts,
                (select count(*)::int from receipts where tenant_id = $1 and needs_review) as flagged,
                (select count(*)::int from receipt_reviews where tenant_id = $1) as reviews,
                (select coalesce(sum(total), 0)::bigint from receipts where tenant_id = $1) as total,
                (select coalesce(sum(amount), 0)::bigint from receipt_payments where tenant_id = $1) as paid,
                (select coalesce(sum(tax_total), 0)::bigint from receipts where tenant_id = $1) as tax,
                (select count(distinct employee_id)::int from receipts where tenant_id = $1) as sellers,
                (select count(distinct (device_time at time zone 'Indian/Mauritius')::date)::int from receipts where tenant_id = $1) as days,
                (select count(*)::int from receipts where tenant_id = $1 and (device_time at time zone 'Indian/Mauritius')::date >= (now() at time zone 'Indian/Mauritius')::date) as today,
                (select count(*)::int from day_closes where tenant_id = $1) as closes,
                (select count(*)::int from shifts where tenant_id = $1 and closed_at is null) as open,
                (select count(*)::int from shifts where tenant_id = $1 and counted_cash <> expected_cash) as short,
                (select count(*)::int from timeclock_punches where tenant_id = $1) as punches,
                (select count(*)::int from tickets where tenant_id = $1 and status <> 'paid') as unpaid,
                (select count(*)::int from pos_devices where tenant_id = $1 and deleted_at is null) as tills,
                (select count(*)::int from stock_levels where tenant_id = $1 and qty < 0) as below,
                (select count(*)::int from stock_levels where tenant_id = $1 and qty > 0 and qty < reorder_point) as low,
                (select count(*)::int from stock_movements where tenant_id = $1 and reason = 'sale') as sold,
                (select count(distinct (created_at at time zone 'Indian/Mauritius')::date)::int from stock_movements where tenant_id = $1 and reason = 'sale') as sold_days,
                (select count(*)::int from stock_movements m where m.tenant_id = $1 and m.reason = 'opening'
                    and m.created_at >= (select min(device_time) from receipts r where r.tenant_id = $1)) as opening_late,
                (select count(*)::int from tickets where tenant_id = $1 and (created_at at time zone 'Indian/Mauritius')::date >= (now() at time zone 'Indian/Mauritius')::date) as orders_today,
                (select count(*)::int from stock_movements where tenant_id = $1 and (created_at at time zone 'Indian/Mauritius')::date >= (now() at time zone 'Indian/Mauritius')::date) as moves_today`, [t]);
      check(`S3 the ${label} has its ${items} things to sell, three staff with a PIN, eight customers`, g.items === items && g.staff === 3 && g.customers === 8 && g.tables === (label === 'restaurant' ? 12 : 0), JSON.stringify([g.items, g.staff, g.customers, g.tables]));
      check(`S3 the ${label} has sales on every day it traded and none today`, g.receipts > DAYS * 5 && g.days === g.closes && g.days >= DAYS - 1 && g.today === 0, JSON.stringify([g.receipts, g.days, g.closes, g.today]));
      check(`S3 the ${label}'s sales are whole: paid in full, taxed, none flagged, every order closed, by more than one member of staff`, g.flagged === 0 && g.reviews === 0 && Number(g.total) > 0 && g.total === g.paid && Number(g.tax) > 0 && g.unpaid === 0 && g.sellers >= 2, JSON.stringify([g.flagged, g.reviews, g.total, g.paid, g.tax, g.unpaid, g.sellers]));
      check(`S3 the ${label}'s days are opened and closed, the drawer right but for one day, staff clocked in and out`, g.open === 0 && g.short === (g.days > 3 ? 1 : 0) && g.punches === g.days * 3 * 2, JSON.stringify([g.open, g.short, g.punches]));
      check(`S3 the ${label} has no till of its own yet: the one the days were rung up on is switched off`, g.tills === 0, String(g.tills));
      if (label === 'shop') {
        check('S3 the shop\'s stock went down with what was sold, none below nothing, some low', g.below === 0 && g.low > 0 && g.sold > 0, JSON.stringify([g.below, g.low, g.sold]));
        check('S3 and it left on the days it was sold, after stock that was there before the first of them, none of it today', g.sold_days === g.days && g.opening_late === 0 && g.moves_today === 0, JSON.stringify([g.sold_days, g.days, g.opening_late, g.moves_today]));
      } else check('S3 the restaurant counts no stock', g.sold === 0);
      check(`S3 the ${label}'s orders were opened on the days they were paid, none today`, g.orders_today === 0, String(g.orders_today));
    }
    // the PINs it said are the ones stored
    const said = [...done.out.matchAll(/^\s+(\S.*?)\s{2,}(Manager|Cashier|Waiter)\s+(\d{4})\s*$/gm)].map((m) => ({ name: m[1].trim(), pin: m[3] }));
    const stored = (await c.query(`select name, pin_hash from employees where tenant_id = $1 and pin_hash is not null`, [resto])).rows;
    const fits = (pin, hash) => {
      const [, n, salt, want] = hash.split('$');
      return crypto.pbkdf2Sync(pin, Buffer.from(salt, 'base64'), Number(n), 32, 'sha256').toString('base64') === want;
    };
    const firstThree = said.slice(0, 3);
    check('S3 a PIN is said for each member of staff, and it is the one the till will check', said.length === 6 && firstThree.every((s) => stored.some((e) => e.name === s.name && /^pbkdf2-sha256\$20000\$/.test(e.pin_hash) && fits(s.pin, e.pin_hash))), String(said.length));

    // S4 asked again
    const again = run(short(store), 'SeedDemo-Shop', '--apply');
    const after = await has(store);
    check('S4 a client that has something to sell is not filled twice', again.code === 1 && /already has/.test(again.err) && after.items === 32, again.code + ' ' + again.err.slice(0, 90));
  } finally {
    for (const t of [resto, store]) {
      await devguard.cleanupPlatform(c, admin, t);
      await devguard.cleanupTenant(c, t);
    }
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
