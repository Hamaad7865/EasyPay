const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnv(file) {
  const env = {};
  const strip = (v) => { v = v.trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    env[t.slice(0, i).trim()] = strip(t.slice(i + 1));
  }
  return env;
}

async function main() {
  let fileEnv = {};
  try { fileEnv = loadEnv('.env.local'); } catch { /* CI uses process env */ }
  const cs = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
    || fileEnv.DATABASE_URL_UNPOOLED || fileEnv.DATABASE_URL;
  if (!cs) throw new Error('missing DATABASE_URL (env or .env.local)');
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const c = new Client({ connectionString: cs, ssl: { require: true } });
  await c.connect();
  await c.query(`create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await c.query('select filename from schema_migrations')).rows.map(r => r.filename));
  for (const f of files) {
    if (done.has(f)) { console.log('skip ' + f); continue; }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    console.log('apply ' + f);
    await c.query('BEGIN');
    try {
      await c.query(sql);
      await c.query('insert into schema_migrations (filename) values ($1)', [f]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw new Error(f + ': ' + e.message);
    }
  }
  await c.end();
  console.log('migrations ok');
}

main().catch(e => { console.error('MIGRATE_FAILED:' + e.message); process.exit(1); });
