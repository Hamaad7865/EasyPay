// tablet-codes.test.cjs — migration 0099: a tablet is set up with a code,
// one code for one tablet, and a tablet that is replaced takes its till with it.
// Everything runs in one transaction that is rolled back.
// Usage: node db/tests/tablet-codes.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  // runs a statement that is expected to fail, without losing the transaction
  async function failsWith(sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT ' + name); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e; }
  }
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  try {
    const admin = crypto.randomUUID(), stranger = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'codes-test@example.com')`, [admin]);
    const tid = crypto.randomUUID(), other = crypto.randomUUID();
    await c.query(`insert into tenants (id, tenant_id, name, plan) values ($1,$1,'Chez Code','offline'), ($2,$2,'Other Code','offline')`, [tid, other]);
    const store = (await one(`insert into stores (tenant_id, name, code) values ($1,'Main store','TCS1') returning id`, [tid])).id;
    const otherStore = (await one(`insert into stores (tenant_id, name, code) values ($1,'Main store','TCS2') returning id`, [other])).id;
    const role = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
    const cashierRole = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Cashier','["sale.create"]'::jsonb) returning id`, [tid])).id;
    // the cashier is the older row: the key must still stand for the owner
    await c.query(`insert into employees (tenant_id, name, role_id, created_at) values ($1,'Cashier',$2, now() - interval '2 days')`, [tid, cashierRole]);
    const owner = (await one(`insert into employees (tenant_id, name, role_id, auth_user_id) values ($1,'Owner',$2,$3) returning id`, [tid, role, crypto.randomUUID()])).id;

    const add = async (who, st) => (await one(`select platform.tablet_code_add($1, $2) as r`, [who, st])).r;
    const redeem = async (code, device, tablet, name, must) =>
      (await one(`select redeem_tablet_code($1, $2, $3, $4, '13', $5) as r`, [code, device, tablet, name === undefined ? null : name, must === undefined ? null : must])).r;
    const login = async (dev, key) => (await one(`select device_login($1, $2) as r`, [dev, key])).r;
    const states = async () => (await one(`select platform.tablet_codes($1) as r`, [tid])).r;

    // A: a code is made
    const first = await add(admin, store);
    {
      check('A1 a code is twelve characters in three groups, none of them easily mistaken', /^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}$/.test(first.code), first.code.replace(/[A-Z0-9]/g, 'X'));
      const row = await one(`select encode(code_hash, 'hex') as h, hint, device_id, used_at, ended_at from tablet_codes where id = $1`, [first.id]);
      const plain = first.code.replace(/-/g, '');
      check('A1 what is kept is its SHA-256 and its last four characters, not the code', row.h === crypto.createHash('sha256').update(plain).digest('hex') && row.hint === plain.slice(-4) && !JSON.stringify(row).includes(plain));
      check('A1 it waits: no till, not used, not ended', row.device_id === null && row.used_at === null && row.ended_at === null);
      let e = await failsWith(`select platform.tablet_code_add($1, $2)`, [stranger, store]);
      check('A2 only a platform admin makes one', e && /not-a-platform-admin/.test(e.message), e && e.message);
      e = await failsWith(`select platform.tablet_code_add($1, $2)`, [admin, crypto.randomUUID()]);
      check('A2 and only for a store that is there', e && /unknown-store/.test(e.message), e && e.message);
      const logged = await one(`select count(*)::int as n from platform.audit where tenant_id = $1 and action = 'tablet.add' and detail->>'code_id' = $2`, [tid, first.id]);
      check('A3 it is written in what was done here, without the code', logged.n === 1);
    }

    // R: a tablet uses it
    const dev1 = crypto.randomUUID(), tabletA = 'tablet-a-' + crypto.randomUUID(), tabletB = 'tablet-b-' + crypto.randomUUID();
    let r1, spare;
    {
      // typed in small letters with spaces: it is the same code
      r1 = await redeem(' ' + first.code.toLowerCase().replace(/-/g, ' ') + ' ', dev1, tabletA);
      check('R1 the code sets the tablet up: its business, its store, the id the tablet made', r1.ok === true && r1.tenant_id === tid && r1.store_id === store && r1.device_id === dev1 && r1.business === 'Chez Code' && r1.moved === false, JSON.stringify({ ...r1, key: undefined }));
      check('R1 as the store\'s first till', r1.code === 'T1' && r1.name === 'Till 1' && Number(r1.last_receipt_seq) === 0, r1.code + ' ' + r1.name);
      const who = await login(dev1, r1.key);
      check('R1 with a key that stands for the business\'s owner, not for whoever is oldest', who.ok === true && who.employee_id === owner && who.tenant_id === tid && who.store_id === store, JSON.stringify(who));
      const row = await one(`select device_id, tablet, used_at from tablet_codes where id = $1`, [first.id]);
      check('R1 the code is used: by that tablet, for that till', row.device_id === dev1 && row.tablet === tabletA && row.used_at !== null);

      const thief = await redeem(first.code, crypto.randomUUID(), tabletB);
      check('R2 a second tablet is refused: one code, one tablet', thief.ok === false && thief.why === 'used', JSON.stringify(thief));
      const tills = await one(`select count(*)::int as n from pos_devices where tenant_id = $1`, [tid]);
      check('R2 and no till was made for it', tills.n === 1, String(tills.n));
      const again = await redeem(first.code, dev1, tabletA);
      check('R3 the tablet that used it may ask again: the same till, a new key', again.ok === true && again.device_id === dev1 && again.key !== r1.key && again.code === 'T1' && again.moved === false);
      const old = await login(dev1, r1.key);
      check('R3 and the key before it is dead', old.ok === false && (await login(dev1, again.key)).ok === true, JSON.stringify(old));
      r1 = again;

      const second = await add(admin, store);
      const dev2 = crypto.randomUUID();
      const r2 = await redeem(second.code, dev2, tabletB, '  ' + 'Bar '.repeat(20));
      check('R4 the next code is the next till, under the name the tablet gave, cut to forty', r2.ok === true && r2.code === 'T2' && r2.name === 'Bar '.repeat(10).trim(), r2.code + ' "' + r2.name + '"');

      const wrong = await redeem('AAAA-BBBB-CCCC', crypto.randomUUID(), tabletA);
      const short = await redeem('ABC', crypto.randomUUID(), tabletA);
      const noDevice = await redeem(first.code, null, tabletA);
      const noTablet = await redeem(first.code, dev1, '  ');
      check('R5 what is not a code, or no code of ours, is refused the same way', [wrong, short, noDevice, noTablet].every((x) => x.ok === false && x.why === 'bad-code'), JSON.stringify([wrong, short, noDevice, noTablet]));
      const third = await add(admin, store);
      const taken = await redeem(third.code, dev1, 'tablet-c');
      check('R6 an id that is another till\'s is refused, and the code is still to use', taken.ok === false && taken.why === 'bad-device' && (await one(`select used_at from tablet_codes where id = $1`, [third.id])).used_at === null, JSON.stringify(taken));

      await c.query(`update tenants set status = 'suspended' where id = $1`, [tid]);
      const susp = await redeem(third.code, crypto.randomUUID(), 'tablet-c');
      await c.query(`update tenants set status = 'active' where id = $1`, [tid]);
      check('R7 a suspended business sets up no tablet', susp.ok === false && susp.why === 'suspended', JSON.stringify(susp));
      await c.query(`update employees set is_active = false where id = $1`, [owner]);
      const nobody = await redeem(third.code, crypto.randomUUID(), 'tablet-c');
      await c.query(`update employees set is_active = true where id = $1`, [owner]);
      check('R7 nor one where nobody may set up tills', nobody.ok === false && nobody.why === 'no-owner', JSON.stringify(nobody));
      spare = third; // taken back below (E1)
    }

    // M: the tablet is replaced
    {
      await c.query(`update pos_devices set last_receipt_seq = 41 where id = $1`, [dev1]);
      const moved = (await one(`select platform.tablet_code_move($1, $2) as r`, [admin, dev1])).r;
      check('M1 moving a till gives a new code', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(moved.code) && moved.code !== first.code);
      const dead = await login(dev1, r1.key);
      check('M1 and the old tablet\'s key ends at once', dead.ok === false && dead.why === 'revoked', JSON.stringify(dead));
      const olds = await redeem(first.code, dev1, tabletA);
      check('M2 the code it was set up with is over, for that tablet too', olds.ok === false && olds.why === 'ended', JSON.stringify(olds));
      const newTablet = 'tablet-new-' + crypto.randomUUID();
      const r = await redeem(moved.code, crypto.randomUUID(), newTablet);
      check('M3 the new tablet IS that till: its id whatever id it sent, its code, its receipt numbers', r.ok === true && r.device_id === dev1 && r.code === 'T1' && Number(r.last_receipt_seq) === 41 && r.moved === true, JSON.stringify({ ...r, key: undefined }));
      check('M3 with a key of its own', (await login(dev1, r.key)).ok === true);
      const tills = await one(`select count(*)::int as n from pos_devices where tenant_id = $1`, [tid]);
      check('M3 and no till was added', tills.n === 2, String(tills.n));
      const stray = await redeem(moved.code, crypto.randomUUID(), tabletA);
      check('M4 the old tablet cannot take the new code', stray.ok === false && stray.why === 'used', JSON.stringify(stray));

      let e = await failsWith(`select platform.tablet_code_move($1, $2)`, [stranger, dev1]);
      check('M5 only a platform admin moves one', e && /not-a-platform-admin/.test(e.message), e && e.message);
      e = await failsWith(`select platform.tablet_code_move($1, $2)`, [admin, crypto.randomUUID()]);
      check('M5 and only a till that is there', e && /unknown-till/.test(e.message), e && e.message);
      // moved again, and deactivated before the code is used
      const twice = (await one(`select platform.tablet_code_move($1, $2) as r`, [admin, dev1])).r;
      await c.query(`select platform.set_device_active($1, $2, false)`, [admin, dev1]);
      const off = await redeem(twice.code, crypto.randomUUID(), 'tablet-late');
      check('M6 a code does not bring back a till that was deactivated', off.ok === false && off.why === 'till-off', JSON.stringify(off));
      e = await failsWith(`select platform.tablet_code_move($1, $2)`, [admin, dev1]);
      check('M6 and a deactivated till is not moved', e && /till-off/.test(e.message), e && e.message);
      await c.query(`select platform.set_device_active($1, $2, true)`, [admin, dev1]);
    }

    // B: a tablet filled from a backup has to be the till the backup is of (0100)
    {
      const devB = crypto.randomUUID();
      const forB = await add(admin, store);
      const rb = await redeem(forB.code, devB, 'tablet-b1');
      const fresh = await add(admin, store);
      const notMine = await redeem(fresh.code, devB, 'tablet-b2', null, devB);
      check('B1 a code for a new tablet does not fill a tablet from a backup, and is still to use', notMine.ok === false && notMine.why === 'other-till' && (await one(`select used_at from tablet_codes where id = $1`, [fresh.id])).used_at === null, JSON.stringify(notMine));
      await c.query(`select platform.tablet_code_end($1, $2)`, [admin, fresh.id]);
      const movedB = (await one(`select platform.tablet_code_move($1, $2) as r`, [admin, devB])).r;
      const wrongTill = await redeem(movedB.code, crypto.randomUUID(), 'tablet-b2', null, crypto.randomUUID());
      check('B2 nor does the replacement code of another till', wrongTill.ok === false && wrongTill.why === 'other-till' && (await one(`select used_at from tablet_codes where id = $1`, [movedB.id])).used_at === null, JSON.stringify(wrongTill));
      const right = await redeem(movedB.code, devB, 'tablet-b2', null, devB);
      check('B3 the code made for the replacement of that till does', right.ok === true && right.device_id === devB && right.moved === true && rb.ok === true, JSON.stringify({ ...right, key: undefined }));
      // out of the list checked below
      await c.query(`delete from tablet_codes where id in ($1, $2, $3)`, [forB.id, fresh.id, movedB.id]);
      await c.query(`delete from device_keys where device_id = $1`, [devB]);
      await c.query(`delete from pos_devices where id = $1`, [devB]);
    }

    // E: a code nobody used is taken back; L: the list
    {
      const third = spare;
      await c.query(`select platform.tablet_code_end($1, $2)`, [admin, third.id]);
      const gone = await redeem(third.code, crypto.randomUUID(), 'tablet-c');
      check('E1 a code taken back sets up nothing', gone.ok === false && gone.why === 'ended', JSON.stringify(gone));
      await c.query(`select platform.tablet_code_end($1, $2)`, [admin, third.id]);
      let e = await failsWith(`select platform.tablet_code_end($1, $2)`, [admin, first.id]);
      check('E2 a code that was used is not taken back: that tablet is moved', e && /code-used/.test(e.message), e && e.message);
      e = await failsWith(`select platform.tablet_code_end($1, $2)`, [admin, crypto.randomUUID()]);
      check('E2 nor one that never was', e && /unknown-code/.test(e.message), e && e.message);

      const list = await states();
      const by = (s) => list.filter((x) => x.state === s).length;
      check('L1 the list says of each code whether it waits, is at work or is over', list.length === 5 && by('waiting') === 1 && by('used') === 1 && by('ended') === 3, JSON.stringify(list.map((x) => x.state)));
      const used = list.find((x) => x.state === 'used');
      check('L1 with its store and its till, and never the code', used.store === 'Main store' && used.till_code === 'T2' && /^[A-Z2-9]{4}$/.test(used.hint) && !JSON.stringify(list).includes(first.code.replace(/-/g, '')), JSON.stringify(used));
      const theirs = (await one(`select platform.tablet_codes($1) as r`, [other])).r;
      check('L2 another business sees none of them', Array.isArray(theirs) && theirs.length === 0);
    }

    // S: it is nobody's to read
    {
      await c.query('SAVEPOINT app');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      let e = await failsWith(`select count(*) from tablet_codes`);
      check('S1 a business\'s own connection cannot read the codes', e && e.code === '42501', e ? e.code : 'no error');
      e = await failsWith(`select redeem_tablet_code('AAAA-BBBB-CCCC', gen_random_uuid(), 'x', null, null, null)`);
      check('S1 nor use one', e && e.code === '42501', e ? e.code : 'no error');
      e = await failsWith(`select platform.tablet_code_add($1, $2)`, [admin, store]);
      check('S1 nor make one', e && e.code === '42501', e ? e.code : 'no error');
      const pull = (await one(`select sync_pull($1::uuid, 0::bigint, 200) as r`, [store])).r;
      check('S2 and no till pulls them', !('tablet_codes' in pull.changes) && !JSON.stringify(pull).includes('code_hash'));
      await c.query('ROLLBACK TO SAVEPOINT app');
    }
    // the other business's store is only there to be left alone
    check('Z nothing was made for the other business', (await one(`select count(*)::int as n from tablet_codes where tenant_id = $1`, [other])).n === 0 && !!otherStore);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + String(e.stack || e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
