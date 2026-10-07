// backoffice-saves.test.cjs — what a few of the back office's forms do when
// what they are sent is not what the page offered: a tax or an add-on group
// removed while the form was open, a table of another store. The saves are
// the pages' own (web/lib/saves.ts), run as the restaurant's own connection.
// Usage: node db/tests/backoffice-saves.test.cjs
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

// a module of web/lib, compiled from the TypeScript it lives in
function lib(name) {
  const web = path.join(__dirname, '..', '..', 'web');
  const ts = require(path.join(web, 'node_modules', 'typescript'));
  const js = ts.transpileModule(fs.readFileSync(path.join(web, 'lib', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
}

(async () => {
  const saves = lib('saves');

  // ---- the kitchen notes a restaurant saved (no database) ----
  {
    const s = lib('settings');
    const usual = s.DEFAULT_SETTINGS.kitchenNotes.join('|');
    const notes = (raw) => s.withDefaults(raw).kitchenNotes;
    check('N1 a restaurant that never saved its notes is offered the usual five', usual.split('|').length === 5 && notes(null).join('|') === usual && notes({ decimals: 2 }).join('|') === usual);
    check('N1 the notes saved are the notes offered, twelve at most', notes({ kitchenNotes: [' Sans piment ', '', 'Rush'] }).join('|') === 'Sans piment|Rush'
      && notes({ kitchenNotes: Array.from({ length: 20 }, (_, i) => 'n' + i) }).length === 12);
    check('N2 a list saved empty stays empty', notes({ kitchenNotes: [] }).length === 0 && notes({ kitchenNotes: ['', ' '] }).length === 0,
      JSON.stringify(notes({ kitchenNotes: [] })));
    check('N2 something that is not a list is the usual five', notes({ kitchenNotes: 'Rush' }).join('|') === usual && notes({ kitchenNotes: null }).join('|') === usual);
  }

  const env = devguard.envMap();
  const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const other = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  // one change, the way a form's action makes it: the restaurant's own transaction
  async function asApp(tenant, fn) {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    try { const out = await fn(); await c.query('COMMIT'); return out; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
  }

  try {
    await c.query(`insert into tenants (id, tenant_id, name) values ($1, $1, 'Saves-Probe'), ($2, $2, 'Saves-Other')`, [tid, other]);
    await q1(`insert into stores (tenant_id, name, code) values ($1, 'Main', 'SVS1') returning id`, [tid]);

    // ---- an item's tax ----
    {
      const vat = (await q1(`insert into taxes (tenant_id, name, rate_bp, type) values ($1, 'VAT 15%', 1500, 'included') returning id`, [tid])).id;
      const zero = (await q1(`insert into taxes (tenant_id, name, rate_bp, type) values ($1, 'Zero rated', 0, 'included') returning id`, [tid])).id;
      const gone = (await q1(`insert into taxes (tenant_id, name, rate_bp, type, deleted_at) values ($1, 'Old levy', 500, 'added', now()) returning id`, [tid])).id;
      const theirs = (await q1(`insert into taxes (tenant_id, name, rate_bp, type) values ($1, 'VAT 15%', 1500, 'included') returning id`, [other])).id;
      const item = (await q1(`insert into items (tenant_id, name, price) values ($1, 'Dholl puri', 2500) returning id`, [tid])).id;
      const carried = async () => (await c.query(`select tax_id from item_taxes where tenant_id = $1 and item_id = $2 and deleted_at is null`, [tid, item])).rows.map((r) => r.tax_id);

      const first = await asApp(tid, () => saves.setItemTax(c, tid, item, vat));
      check('T1 an item is given the tax picked', first === true && (await carried()).join() === vat);
      const changed = await asApp(tid, () => saves.setItemTax(c, tid, item, zero));
      check('T1 picking another tax leaves that one alone on the item', changed === true && (await carried()).join() === zero);
      const back = await asApp(tid, () => saves.setItemTax(c, tid, item, vat));
      check('T1 a tax the item carried before is put back on', back === true && (await carried()).join() === vat);

      const removed = await asApp(tid, () => saves.setItemTax(c, tid, item, gone));
      check('T2 a tax removed while the panel was open is refused', removed === false, String(removed));
      check('T2 and the item keeps the tax it had', (await carried()).join() === vat, JSON.stringify(await carried()));
      const foreign = await asApp(tid, () => saves.setItemTax(c, tid, item, theirs));
      check('T2 a tax of another restaurant is refused, the item keeping its own', foreign === false && (await carried()).join() === vat, JSON.stringify(await carried()));
      const unknown = await asApp(tid, () => saves.setItemTax(c, tid, item, crypto.randomUUID()));
      check('T2 a tax that never existed is refused, the item keeping its own', unknown === false && (await carried()).join() === vat, JSON.stringify(await carried()));
    }
  } finally {
    for (const t of [tid, other]) {
      try { await devguard.cleanupTenant(c, t); } catch (e) { console.error('cleanup of ' + t + ' failed: ' + e.message); failures++; }
    }
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
