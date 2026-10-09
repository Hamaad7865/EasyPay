// read-usage.cjs — asks Neon what the project has used and saves the answer
// where the admin area's Usage page reads it (platform.usage_days, migration
// 0090). Neon's free plan keeps no history and has no read-only key, so the
// back office never asks Neon itself: this does, every hour, from GitHub
// (.github/workflows/usage.yml), which holds the key already.
//
//   node db/scripts/read-usage.cjs            saves into production, if it is awake
//   node db/scripts/read-usage.cjs --always   saves even when it is asleep (this wakes it)
//   node db/scripts/read-usage.cjs --dev      saves into the dev branch of .env.local instead
//
// It saves only while the branch's compute is awake, so it never wakes a
// sleeping database. A reading is not free even so: a write restarts Neon's
// five-minute timer, so each can keep the database awake up to five minutes
// longer. About 1 of the 100 compute hours a month.
//
// What it prints is public (the repository's Actions log is): "saved",
// "asleep" or "not released yet", and never a figure, a client's name or the
// database's address. When Neon's answer lacks a figure the page needs, it
// stops and names the figure.
//
// Neon is asked through its CLI, as db/migrate-production.cjs does: signed in
// on this PC, and on GitHub by the NEON_API_KEY it is given.
const { execSync } = require('child_process');
const path = require('path');

const PROJECT = 'snowy-fire-89764432';

// a figure the page cannot do without: named when it is missing, never shown
function need(of, key, what) {
  if (of === null || typeof of !== 'object' || of[key] === undefined || of[key] === null) throw new Error(`Neon's answer has no ${key} for ${what}`);
  return of[key];
}

// One reading, as platform.usage_read takes it: the project's totals for the
// period and each branch's part of them.
function reading(projectAnswer, branchesAnswer, now) {
  const p = need(projectAnswer, 'project', 'the project');
  const list = need(branchesAnswer, 'branches', 'the project');
  if (!Array.isArray(list) || list.length === 0) throw new Error(`Neon's answer has no branches for the project`);
  return {
    project_id: need(p, 'id', 'the project'),
    read_at: now.toISOString(),
    period_start: need(p, 'consumption_period_start', 'the project'),
    period_end: p.consumption_period_end ?? null,
    plan: p.owner?.subscription_type ?? null,
    compute_seconds: need(p, 'compute_time_seconds', 'the project'),
    active_seconds: need(p, 'active_time_seconds', 'the project'),
    storage_limit_bytes: p.branch_logical_size_limit_bytes ?? null,
    branches_limit: p.owner?.branches_limit ?? null,
    branches: list.map((b) => ({
      name: need(b, 'name', 'a branch'),
      default: b.default === true,
      compute_seconds: need(b, 'compute_time_seconds', 'a branch'),
      active_seconds: need(b, 'active_time_seconds', 'a branch'),
      logical_size: b.logical_size ?? null,
    })),
  };
}

function branchNamed(branchesAnswer, name) {
  const found = need(branchesAnswer, 'branches', 'the project').find((b) => b.name === name);
  if (!found) throw new Error(`the project has no branch named ${name}`);
  return found;
}

// whether the compute that writes to a branch is running now
function awake(endpointsAnswer, branchId) {
  return need(endpointsAnswer, 'endpoints', 'the project').some((e) => e.branch_id === branchId && e.type === 'read_write' && e.current_state === 'active');
}

function ask(route, what) {
  let out;
  try {
    out = execSync(`neon api ${route}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`Neon could not be asked for ${what}`);
  }
  try { return JSON.parse(out); } catch { throw new Error(`Neon's answer for ${what} could not be read`); }
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.find((a) => !['--dev', '--always'].includes(a));
  if (unknown) throw new Error(`"${unknown}" is not something this takes: --dev, --always`);
  const dev = args.includes('--dev');

  const branches = ask(`/projects/${PROJECT}/branches`, 'the branches');
  const made = reading(ask(`/projects/${PROJECT}`, 'the project'), branches, new Date());
  // required here, not at the top: the dev guard refuses, on require, a .env.local that points at production
  const branch = dev ? require(path.join(__dirname, '..', 'tests', 'require-dev.cjs')).envMap().NEON_BRANCH : 'production';
  if (!args.includes('--always') && !awake(ask(`/projects/${PROJECT}/endpoints`, 'the computes'), branchNamed(branches, branch).id)) {
    console.log('asleep: nothing saved');
    return;
  }

  const { Client } = require('pg');
  const { connection } = require('./connection.cjs');
  const c = new Client({ connectionString: connection(dev).url, ssl: { require: true } });
  // what the database says is not printed as it is: it can name the host
  const refused = (e) => new Error(`the database did not take the reading (${e.code || 'no code'})`);
  try { await c.connect(); } catch (e) { throw refused(e); }
  try {
    await c.query(`select platform.usage_read($1::jsonb)`, [JSON.stringify(made)]);
    console.log('saved');
  } catch (e) {
    // the schema or the function is not there: migration 0090 has not reached this database yet
    if (e.code === '3F000' || e.code === '42883') console.log('not released yet: nothing saved');
    else throw refused(e);
  } finally {
    await c.end().catch(() => {});
  }
}

if (require.main === module) main().catch((e) => { console.error('READ_USAGE_FAILED: ' + e.message); process.exit(1); });

module.exports = { reading, awake, branchNamed };
