// dump-function.cjs — prints the definition a public function has now on the
// linked dev branch. A fix-forward migration starts from that text, not from
// an older migration file, because a later migration may have replaced it.
// Usage: node db/scripts/dump-function.cjs push_receipt_create > some-file.sql
const { Client } = require('pg');
const devguard = require('../tests/require-dev.cjs');

(async () => {
  const name = process.argv[2];
  if (!name) throw new Error('usage: node db/scripts/dump-function.cjs <function name>');
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const r = await c.query(
    `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1`, [name]);
  await c.end();
  if (r.rowCount !== 1) throw new Error(`${r.rowCount} functions named ${name}`);
  process.stdout.write(r.rows[0].def + ';\n');
})().catch((e) => { console.error('DUMP_FAILED:' + e.message); process.exit(1); });
