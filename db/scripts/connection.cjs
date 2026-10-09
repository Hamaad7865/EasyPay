// connection.cjs — which database a script run by a person talks to:
// production, or with --dev the dev branch of .env.local.
//
// Production's connection comes from the Neon CLI (already signed in on this
// PC), as in db/migrate-production.cjs; what comes back is checked to be the
// production host before it is used, and it is never printed and never
// written to a file. The dev branch goes through the guard the suites use,
// which refuses, on require, anything that is or points at production.
const { execSync } = require('child_process');
const path = require('path');

const PROJECT = 'snowy-fire-89764432';
const BRANCH = 'production';
// the production compute's host begins with this; the dev branch's does not
const HOST = 'ep-soft-poetry';

function connection(dev) {
  if (dev) {
    process.chdir(path.join(__dirname, '..', '..'));
    const guard = require(path.join(__dirname, '..', 'tests', 'require-dev.cjs'));
    const env = guard.envMap();
    return { url: env.DATABASE_URL_UNPOOLED, where: `dev (${env.NEON_BRANCH})` };
  }
  const url = execSync(`neon connection-string ${BRANCH} --project-id ${PROJECT} --role-name neondb_owner`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const host = new URL(url).hostname;
  if (!host.startsWith(HOST)) throw new Error(`this is not the production host (${host.split('.')[0]}): nothing was done`);
  return { url, where: `production (${host.split('.')[0].replace(/-[a-z0-9]{8}$/, '-…')})` };
}

// A client named twice, by the eight characters under its name on /admin and
// by its name as written there: both must be one and the same client.
async function clientOf(c, short, name) {
  const found = (await c.query(
    `select id, name, business_type, plan, status, created_at::date::text as made from tenants where upper(left(id::text, 8)) = upper($1)`, [short])).rows;
  if (!found.length) throw new Error(`no client has the ID ${short.toUpperCase()}`);
  if (found.length > 1) throw new Error(`${found.length} clients have an ID beginning ${short.toUpperCase()}`);
  if (found[0].name !== name) throw new Error(`${short.toUpperCase()} is "${found[0].name}", not "${name}"`);
  return found[0];
}

// The clients named on the command line: ID and name, ID and name.
function pairsOf(named, script) {
  const usage = `say which client twice, its ID and its name: node db/scripts/${script} 7BAFE3B9 "Hamaad Retail"`;
  if (!named.length || named.length % 2) throw new Error(`${usage}: nothing was done`);
  const pairs = [];
  for (let i = 0; i < named.length; i += 2) {
    if (!/^[0-9a-f]{8}$/i.test(named[i])) throw new Error(`"${named[i]}" is not an ID (eight characters, as under the client's name on /admin). ${usage}: nothing was done`);
    pairs.push([named[i], named[i + 1]]);
  }
  return pairs;
}

module.exports = { connection, clientOf, pairsOf };
