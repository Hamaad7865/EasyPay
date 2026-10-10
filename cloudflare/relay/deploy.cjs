// deploy.cjs — puts the ordering site (order.easypaypos.com) live, told where
// production's till service is, and says how it stands. Run by a person, on
// purpose:
//
//   node cloudflare/relay/deploy.cjs            looks and checks, changes nothing
//   node cloudflare/relay/deploy.cjs --apply    deploys, then asks the live address whether it answers
//
// The relay asks EasyPay's till service whose till is connecting, so it has to
// be given that service's address (TILL_API). It is the address the released
// till syncs with, which the repository already holds as the variable
// TILL_FUNCTION_URL (cloudflare/production-settings.cjs put it there). This
// reads it from GitHub and hands it to the deploy, so nothing is typed or
// pasted, and wrangler.toml keeps no address of production. That is also why
// a plain `wrangler deploy` from this folder is the wrong way to deploy: it
// would put the relay live with no address, and every till would be turned
// away. Run without --apply, this says so if it has happened.
//
// It needs gh and wrangler signed in on this PC, as the other scripts here do.
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { wrongFunction, setting } = require('../production-settings.cjs');

const REPO = 'Hamaad7865/EasyPay';
const LIVE = 'https://order.easypaypos.com';
const WRANGLER = 'wrangler@4.117.0'; // the version web/ builds and deploys with
// For trying the looking on this PC (the relay under `wrangler dev`, the dev
// branch's till service): with either set, --apply is refused.
const SITE = (process.env.EASYPAY_RELAY_SITE || LIVE).replace(/\/$/, '');
const GIVEN = (process.env.EASYPAY_TILL_API || '').replace(/\/$/, '');

// One request, answered with its status and what it said; never throws.
// `till` makes it the first half of a till's connection: a WebSocket's
// opening request with a credential nobody has.
function ask(address, { till = false } = {}) {
  return new Promise((done) => {
    let u;
    try { u = new URL(address); } catch { return done({ status: 0, said: 'not an address' }); }
    const headers = till
      ? { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'ZWFzeXBheS1kZXBsb3ktY2s=', authorization: 'Device 00000000-0000-4000-8000-000000000000:' + '0'.repeat(64) }
      : {};
    const req = (u.protocol === 'http:' ? http : https).request(u, { method: 'GET', headers, timeout: 20000 }, (res) => {
      let said = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (said.length < 2000) said += c; });
      res.on('end', () => done({ status: res.statusCode, type: String(res.headers['content-type'] || ''), said }));
    });
    // a made-up till that is let in would be a fault of the service, not of this script: hang up and say so
    req.on('upgrade', (res, socket) => { socket.destroy(); done({ status: 101, said: '' }); });
    req.on('timeout', () => req.destroy(new Error('no answer in 20 seconds')));
    req.on('error', (e) => done({ status: 0, said: e.code || e.message }));
    req.end();
  });
}

// What the till service says of /guest/pass to someone with no credential.
function passAnswer(r) {
  if (r.status === 401) return { there: true, words: 'it answers /guest/pass (and turns away whoever has no credential)' };
  if (r.status === 404) return { there: false, words: 'it has no /guest/pass yet: that comes with the release (the tag). Until then every till is turned away, and the page still answers.' };
  if (r.status === 0) return { there: false, wrong: true, words: `it did not answer (${r.said})` };
  return { there: false, wrong: true, words: `it answered ${r.status} to /guest/pass, which is not expected` };
}

// What the live relay says to a till nobody has.
function tillAnswer(r) {
  const error = (() => { try { return JSON.parse(r.said).error || ''; } catch { return ''; } })();
  if (r.status === 401) return { ok: true, words: 'a made-up till is turned away by EasyPay: the relay reaches the till service, and the service answers' };
  if (r.status === 503 && /has not been told/.test(error)) return { ok: false, words: 'the relay is live WITHOUT the till service\'s address (a plain "wrangler deploy"?): every till is turned away. Run this with --apply.' };
  if (r.status === 503) return { ok: false, words: 'the relay is live, and the till service does not answer it yet (no /guest/pass before the release)' };
  if (r.status === 0) return { ok: false, words: `it did not answer (${r.said})` };
  if (r.status === 101) return { ok: false, words: 'a made-up till was LET IN, which must never happen: the till service is not checking who connects' };
  return { ok: false, words: `it answered ${r.status}, which is not expected${error ? ': ' + error : ''}` };
}

module.exports = { passAnswer, tillAnswer };
if (require.main !== module) return;

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// how the live address stands: its page, its Worker, and a till's way in
async function look() {
  const page = await ask(SITE + '/');
  const worker = await ask(SITE + '/api/aaaaaaaaaaaaaaaa/menu/x');
  const pageUp = page.status === 200 && /html/.test(page.type || '');
  const workerUp = worker.status === 404 && /json/.test(worker.type || '');
  console.log(`\nThe ordering site, ${SITE}:`);
  console.log(`  ${pageUp ? 'ok       ' : 'NOT UP   '}  the guest's page  ${pageUp ? '' : '— ' + (page.status ? 'answered ' + page.status : page.said)}`);
  console.log(`  ${workerUp ? 'ok       ' : 'NOT UP   '}  the relay behind it  ${workerUp ? '' : '— ' + (worker.status ? 'answered ' + worker.status : worker.said)}`);
  if (!workerUp) return false;
  const till = tillAnswer(await ask(SITE + '/api/till', { till: true }));
  console.log(`  ${till.ok ? 'ok       ' : 'NOT YET  '}  ${till.words}`);
  return true;
}

(async () => {
  const apply = process.argv.includes('--apply');
  if (apply && (GIVEN || SITE !== LIVE)) {
    console.log('Nothing was deployed: EASYPAY_TILL_API and EASYPAY_RELAY_SITE are for trying the looking only.');
    process.exit(1);
  }

  // where production's till service is
  let api = GIVEN;
  if (!api) {
    try { api = execSync(`gh variable get TILL_FUNCTION_URL --repo ${REPO}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().replace(/\/$/, ''); }
    catch (e) { console.log(`GitHub did not give the variable TILL_FUNCTION_URL (${String(e.stderr || e.message).trim().split(/\r?\n/).pop()}).\nIs gh signed in? node cloudflare/production-settings.cjs --apply sets the variable.`); process.exit(1); }
  }
  // what this PC has of the dev branch, to tell the two apart
  const devApi = setting(read(path.join(__dirname, '..', '..', 'android', 'local.properties')), 'functionUrl');
  const wrong = GIVEN ? null : wrongFunction(api, devApi);
  console.log(`The till service${GIVEN ? ' (given, for trying)' : ' (GitHub variable TILL_FUNCTION_URL)'}:`);
  console.log(`  ${wrong ? 'NOT RIGHT' : 'ok       '}  ${api}${wrong ? '  — ' + wrong : ''}`);
  if (wrong) { console.log('\nNothing was changed.'); process.exit(1); }
  const pass = passAnswer(await ask(api + '/guest/pass'));
  console.log(`  ${pass.there ? 'ok       ' : pass.wrong ? 'NOT RIGHT' : 'NOT YET  '}  ${pass.words}`);
  if (pass.wrong) { console.log('\nNothing was changed: the relay would have nobody to ask.'); process.exit(1); }

  if (!apply) {
    await look();
    console.log('\nNothing was changed. To deploy: node cloudflare/relay/deploy.cjs --apply');
    return;
  }

  // the deploy: the Worker, its rooms and, the first time, the address itself
  console.log(`\nDeploying easypay-relay to ${LIVE} ...\n`);
  const r = spawnSync(`npx --yes ${WRANGLER} deploy --var TILL_API:${api}`, { shell: true, cwd: __dirname, stdio: 'inherit' });
  if (r.status !== 0) { console.log('\nNOT DEPLOYED: wrangler stopped (see above). Nothing of EasyPay was changed.'); process.exit(1); }

  // a new address takes a moment to get its certificate
  for (let i = 0; i < 12; i++) {
    const r2 = await ask(LIVE + '/api/aaaaaaaaaaaaaaaa/menu/x');
    if (r2.status === 404 && /json/.test(r2.type || '')) break;
    if (i === 0) console.log('\nWaiting for the address to answer (a new one takes a minute or two) ...');
    await sleep(10000);
  }
  const up = await look();
  console.log(up
    ? '\nDeployed. A card\'s address now answers; a till is let in once the release has put /guest/pass on production and its restaurant has the switch on.'
    : '\nDeployed, but the address does not answer yet. Give it a few minutes, then: node cloudflare/relay/deploy.cjs');
  process.exit(up ? 0 : 1);
})();
