// migrate-production.cjs — applies the migrations production does not have
// yet. Run by a person, on purpose:
//
//   node db/migrate-production.cjs                        shows what would be applied, changes nothing
//   node db/migrate-production.cjs --apply                applies it
//   node db/migrate-production.cjs --until 0084           the same list, stopping after 0084
//   node db/migrate-production.cjs --until 0084 --apply   applies up to 0084 and no further
//
// --until is for a migration that switches something on for every client and
// so has a day of its own. 0085 is one: from the moment it is applied, every
// restaurant whose plan is not Premium or Trial has no Bookings and no
// Kitchen screen, and a booking from a till older than 0.6.0 is refused.
//
// It asks the Neon CLI (already signed in on this PC) for production's
// connection, checks that what it got really is the production branch of the
// EasyPay project, and hands it to db/migrate.cjs for this one run. The
// connection is never printed and never written to a file; .env.local stays
// the dev branch's. Each migration is one transaction (see migrate.cjs): a
// file that fails changes nothing, and the ones before it stay applied.
//
// Before a release with many migrations, take a restore point first:
//   neon branches create --project-id snowy-fire-89764432 --name production-before-NNNN --parent production --compute false
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PROJECT = 'snowy-fire-89764432';
const BRANCH = 'production';
// the production compute's host begins with this; the dev branch's does not
const HOST = 'ep-soft-poetry';

(async () => {
  const apply = process.argv.includes('--apply');
  const at = process.argv.indexOf('--until');
  const until = at < 0 ? '' : String(process.argv[at + 1] || '');
  if (at >= 0 && !/^\d{4}$/.test(until)) throw new Error('--until takes a migration number of four digits, like --until 0084: nothing was done');
  const url = execSync(`neon connection-string ${BRANCH} --project-id ${PROJECT} --role-name neondb_owner`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const host = new URL(url).hostname;
  if (!host.startsWith(HOST)) throw new Error(`this is not the production host (${host.split('.')[0]}): nothing was done`);

  const files = fs.readdirSync(path.join(__dirname, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const c = new Client({ connectionString: url, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  const done = new Set((await c.query('select filename from schema_migrations')).rows.map((r) => r.filename));
  await c.query('ROLLBACK');
  await c.end();
  const missing = files.filter((f) => !done.has(f));
  const pending = until ? missing.filter((f) => f.slice(0, 4) <= until) : missing;
  const held = missing.filter((f) => !pending.includes(f));
  const strange = [...done].filter((f) => !files.includes(f));

  console.log(`production (${host.split('.')[0].replace(/-[a-z0-9]{8}$/, '-…')}) has ${done.size} of ${files.length} migrations.`);
  if (strange.length) console.log(`It has ${strange.length} that this folder does not: ${strange.join(', ')}`);
  // each one by name: what is about to be applied is read before it is
  if (held.length) console.log(`${held.length} left for later (above ${until}):\n${held.map((f) => '  ' + f).join('\n')}`);
  if (!pending.length) { console.log('Nothing to apply.'); return; }
  console.log(`${pending.length} to apply:\n${pending.map((f) => '  ' + f).join('\n')}`);
  if (!apply) { console.log('Nothing was changed. Run again with --apply to apply them.'); return; }

  const run = spawnSync(process.execPath, [path.join(__dirname, 'migrate.cjs')], {
    cwd: path.join(__dirname, '..'), stdio: 'inherit',
    env: { ...process.env, DATABASE_URL_UNPOOLED: url, DATABASE_URL: url, MIGRATE_UNTIL: until },
  });
  process.exit(run.status === null ? 1 : run.status);
})().catch((e) => { console.error('STOPPED: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '***')); process.exit(1); });
