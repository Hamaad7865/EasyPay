// require-dev.cjs — shared test guard + tenant cleanup (review item B8).
// Every db test requires this first: it REFUSES to run when the linked
// branch is production or a connection string points at production, and offers one-transaction cleanup (trigger
// disable, deletes, trigger enable all commit or roll back together).
const CHILD_FIRST = ['receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers','receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets','grid_page_items','grid_pages','store_item_overrides','item_taxes','item_modifier_groups','modifiers','modifier_groups','item_variants','items','taxes','discounts','dining_options','payment_types','employee_stores','employees','roles','categories','pos_devices','stores','sync_ops_applied','tenants'];
const GUARDS = ['receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers','receipt_lines','receipts','sync_ops_applied'];

function loadEnv(file) {
  const fs = require('fs');
  const env = {};
  const strip = (v) => { v = v.trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('='); env[t.slice(0, i).trim()] = strip(t.slice(i + 1));
  }
  return env;
}

function envMap() {
  let fileEnv = {};
  try { fileEnv = loadEnv('.env.local'); } catch {}
  const pick = (k) => process.env[k] || fileEnv[k];
  const strip = (v) => { v = String(v).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  const out = {};
  for (const k of ['DATABASE_URL','DATABASE_URL_UNPOOLED','NEON_BRANCH','NEON_FUNCTION_API_BASE_URL','NEON_AUTH_BASE_URL']) {
    if (pick(k) !== undefined) out[k] = strip(pick(k));
  }
  return out;
}

// The production compute endpoint. A connection string that points here is
// production whatever NEON_BRANCH claims (extra hosts: RESTOPOS_PROD_HOSTS,
// comma-separated).
const PROD_HOSTS = ['ep-soft-poetry-b3lyjmxs'];

function prodHosts() {
  const extra = (process.env.RESTOPOS_PROD_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  return PROD_HOSTS.concat(extra);
}

// Throws unless the linked branch is a non-production branch AND neither
// connection string points at the production endpoint (the label alone can
// drift from where the URL really goes).
function requireDev(env) {
  const branch = env.NEON_BRANCH || '';
  if (!branch || branch === 'production' || branch === 'main') {
    throw new Error(`refusing to run tests against branch '${branch || '(unknown)'}' (review item B8)`);
  }
  for (const k of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    const url = env[k];
    if (!url) continue;
    let host = '';
    try { host = new URL(url).hostname; } catch { host = String(url); }
    const hit = prodHosts().find((h) => host.includes(h));
    if (hit) throw new Error(`refusing to run tests: ${k} points at the production endpoint (${hit})`);
  }
  return branch;
}

// Delete one tenant's rows: guard disable + deletes + guard enable in ONE
// transaction (all commit or all roll back). Owner connection required.
async function cleanupTenant(client, tenantId) {
  await client.query('BEGIN');
  try {
    for (const t of GUARDS) await client.query(`alter table ${t} disable trigger trg_no_update`);
    for (const t of CHILD_FIRST) await client.query(`delete from ${t} where tenant_id='${tenantId}'`);
    for (const t of GUARDS) await client.query(`alter table ${t} enable trigger trg_no_update`);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw new Error('cleanup:' + e.message);
  }
}

module.exports = { loadEnv, envMap, requireDev, cleanupTenant, CHILD_FIRST, GUARDS };

// Checked on require, so a test is refused before it opens any connection.
requireDev(envMap());
