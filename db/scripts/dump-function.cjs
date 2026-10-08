// dump-function.cjs — prints the definition a function has now on the linked
// dev branch. A fix-forward migration starts from that text, not from an older
// migration file, because a later migration may have replaced it.
// The name may carry its schema (platform.create_tenant; public when left
// out). A name that exists more than once, with different arguments, is
// narrowed by how many it takes.
// Usage: node db/scripts/dump-function.cjs push_receipt_create > some-file.sql
//        node db/scripts/dump-function.cjs platform.create_tenant 7
const { Client } = require('pg');
const devguard = require('../tests/require-dev.cjs');

(async () => {
  const asked = process.argv[2];
  if (!asked) throw new Error('usage: node db/scripts/dump-function.cjs [schema.]<function name> [number of arguments]');
  const dot = asked.indexOf('.');
  const schema = dot < 0 ? 'public' : asked.slice(0, dot);
  const name = dot < 0 ? asked : asked.slice(dot + 1);
  const args = process.argv[3] === undefined ? null : Number(process.argv[3]);
  if (args !== null && !Number.isInteger(args)) throw new Error('the number of arguments must be a whole number');
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const r = await c.query(
    `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $2 and p.proname = $1 and ($3::int is null or p.pronargs = $3::int)`, [name, schema, args]);
  await c.end();
  if (r.rowCount !== 1) throw new Error(`${r.rowCount} functions named ${schema}.${name}` + (r.rowCount > 1 ? ': say how many arguments' : ''));
  process.stdout.write(r.rows[0].def + ';\n');
})().catch((e) => { console.error('DUMP_FAILED:' + e.message); process.exit(1); });
