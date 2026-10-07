// prepare-web-sql.cjs — checks the SQL in back office pages without opening them.
// Takes every SQL statement written as a plain template string in the given
// files and asks the linked dev branch to PREPARE it: parsed and planned
// against the real tables and functions, never run. A page that needs a
// login to open can still have its queries checked this way. A statement
// with a ${...} in it is skipped (it is put together at run time).
// Usage: node db/scripts/prepare-web-sql.cjs web/app/backoffice/items/page.tsx [more files]
const fs = require('fs');
const { Client } = require('pg');
const devguard = require('../tests/require-dev.cjs');

const files = process.argv.slice(2);
(async () => {
  if (files.length === 0) throw new Error('usage: node db/scripts/prepare-web-sql.cjs <file> [more files]');
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  let bad = 0, ok = 0, skipped = 0, n = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
      const sql = m[1].trim();
      if (!/^(select|insert|update|delete|with)\b/i.test(sql)) continue;
      if (sql.includes('${')) { skipped++; continue; }
      const name = 'p' + (++n);
      try {
        await c.query(`prepare ${name} as ${sql}`);
        await c.query(`deallocate ${name}`);
        ok++;
      } catch (e) {
        bad++;
        console.log('BAD ' + f + ': ' + e.message + '\n    ' + sql.replace(/\s+/g, ' ').slice(0, 140));
      }
    }
  }
  await c.end();
  console.log(`${ok} statements prepare, ${bad} do not, ${skipped} skipped (put together at run time)`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('PREPARE_FAILED:' + e.message); process.exit(1); });
