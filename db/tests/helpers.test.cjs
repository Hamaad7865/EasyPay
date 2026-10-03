// helpers.test.cjs — Item 1: asTenant (hello.ts) + withTenant (web/lib/db.ts)
// must scope every call in BEGIN/COMMIT with SET LOCAL ROLE + set_config.
// Compiles the real TS sources, then drives both helpers with two tenants.
// Usage: node db/tests/helpers.test.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

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

(async () => {
  const fileEnv = loadEnv('.env.local');
  process.env.DATABASE_URL = process.env.DATABASE_URL || fileEnv.DATABASE_URL;
  process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL_UNPOOLED || fileEnv.DATABASE_URL_UNPOOLED;

  // compile the real helpers (not copies)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpers-'));
  console.log('compiling helpers...');
  execSync(`npx -y -p typescript@5.7.2 tsc --outDir ${dir} --module commonjs --target es2022 --moduleResolution node --esModuleInterop --skipLibCheck hello.ts web/lib/db.ts`, { stdio: 'pipe' });
  // compiled output lives in a temp dir; point resolution at the repo's node_modules
  process.env.NODE_PATH = path.join(process.cwd(), 'node_modules');
  require('module').Module._initPaths();
  const { asTenant } = require(path.join(dir, 'hello.js'));
  const { withTenant } = require(path.join(dir, 'web', 'lib', 'db.js'));
  if (typeof asTenant !== 'function' || typeof withTenant !== 'function') throw new Error('helpers did not export');

  const { Client } = require('pg');
  const strip2 = (v) => { v = v.trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  const cs = strip2(String(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL));
  const admin = new Client({ connectionString: cs, ssl: { require: true } });
  await admin.connect();
  const A = crypto.randomUUID(), B = crypto.randomUUID();
  await admin.query(`insert into tenants (id, tenant_id, name) values ('${A}','${A}','H-A'), ('${B}','${B}','H-B')`);

  for (const [name, helper, call] of [
    ['asTenant', asTenant, (q) => q],
    ['withTenant', withTenant, (c) => c.query.bind(c)],
  ]) {
    // T1: write under A, read back under A
    let wrote = false;
    try {
      await helper(A, async (ctx) => {
        const q = call(ctx);
        await q(`insert into categories (tenant_id, name) values ('${A}','Cat-${name}')`);
        return [];
      });
      wrote = true;
    } catch (e) { console.log(`  (${name} write threw: ` + e.message + ')'); }
    check(`${name}: write under tenant A succeeds`, wrote);
    const seen = await helper(A, (ctx) => call(ctx)(`select name from categories`).then((r) => r.rows));
    check(`${name}: A reads own row`, seen.some((r) => r.name === `Cat-${name}`), JSON.stringify(seen.map((r) => r.name)));
    // T2: B must not see A's row
    const seenB = await helper(B, (ctx) => call(ctx)(`select name from categories`).then((r) => r.rows));
    check(`${name}: B does not see A's row`, !seenB.some((r) => r.name === `Cat-${name}`));
    // T3: throw mid-call rolls everything back
    let threw = false;
    try {
      await helper(A, async (ctx) => {
        const q = call(ctx);
        await q(`insert into categories (tenant_id, name) values ('${A}','Temp-${name}')`);
        throw new Error('boom');
      });
    } catch (e) { threw = e.message === 'boom'; }
    const after = await helper(A, (ctx) => call(ctx)(`select name from categories`).then((r) => r.rows));
    check(`${name}: mid-call throw rolls back`, threw && !after.some((r) => r.name === `Temp-${name}`));
  }

  for (const t of ['categories', 'tenants']) await admin.query(`delete from ${t} where tenant_id in ('${A}','${B}')`);
  await admin.end();
  console.log(failures === 0 ? 'HELPERS PASS' : `HELPERS FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + e.message); process.exit(1); });
