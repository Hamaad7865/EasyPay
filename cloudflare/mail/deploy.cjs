// deploy.cjs — puts EasyPay's mail service (mail.easypaypos.com) live, and says
// how it stands. Run by a person, on purpose:
//
//   node cloudflare/mail/deploy.cjs            looks and checks, changes nothing
//   node cloudflare/mail/deploy.cjs --apply    deploys, then asks the live address whether it answers
//
// The service holds no secret and no address of EasyPay's, so the deploy is
// wrangler's own; this only checks first that easypaypos.com can send mail
// (without it every mail is refused, and tills keep their closings until it
// can), and asks the address afterwards. Needs wrangler signed in on this PC.
const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const LIVE = 'https://mail.easypaypos.com';
const DOMAIN = 'easypaypos.com';
const WRANGLER = 'wrangler@4.117.0'; // the version web/ builds and deploys with

// What `wrangler email sending list` says of the domain.
function sendingAnswer(out) {
  // its name, not its zone: mail is from the domain itself
  const row = String(out).split(/\r?\n/).find((l) => l.split('│').map((c) => c.trim())[2] === DOMAIN);
  if (!row) return { ok: false, words: `${DOMAIN} is not onboarded for sending: run  npx ${WRANGLER} email sending enable ${DOMAIN}` };
  const enabled = row.split('│').map((c) => c.trim())[3];
  return enabled === 'yes'
    ? { ok: true, words: `${DOMAIN} can send mail` }
    : { ok: false, words: `${DOMAIN} is onboarded but not enabled for sending (${enabled || 'no answer'})` };
}

// What the live address says to /health.
function healthAnswer(r) {
  if (r.status === 200 && /"ok":true/.test(r.said)) return { ok: true, words: 'the service answers' };
  if (r.status === 0) return { ok: false, words: `it did not answer (${r.said})` };
  return { ok: false, words: `it answered ${r.status}, which is not expected` };
}

module.exports = { sendingAnswer, healthAnswer };
if (require.main !== module) return;

function ask(address) {
  return new Promise((done) => {
    const req = https.request(address, { method: 'GET', timeout: 20000 }, (res) => {
      let said = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (said.length < 2000) said += c; });
      res.on('end', () => done({ status: res.statusCode, said }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer in 20 seconds')));
    req.on('error', (e) => done({ status: 0, said: e.code || e.message }));
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrangler = (args, inherit = false) => spawnSync(`npx --yes ${WRANGLER} ${args}`, { shell: true, cwd: __dirname, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });

(async () => {
  const apply = process.argv.includes('--apply');

  const list = wrangler('email sending list');
  const sending = list.status === 0 ? sendingAnswer(list.stdout) : { ok: false, words: `wrangler did not say (${String(list.stderr || '').trim().split(/\r?\n/).pop()}). Is it signed in?` };
  console.log(`\nSending from ${DOMAIN}:\n  ${sending.ok ? 'ok       ' : 'NOT YET  '}  ${sending.words}`);
  console.log('  (sending to any address also needs Workers Paid on the account: a mail refused for that is said in the Worker\'s log, `wrangler tail easypay-mail`)');

  const before = healthAnswer(await ask(LIVE + '/health'));
  console.log(`\nThe service, ${LIVE}:\n  ${before.ok ? 'ok       ' : 'NOT UP   '}  ${before.words}`);

  if (!apply) {
    console.log('\nNothing was changed. To deploy: node cloudflare/mail/deploy.cjs --apply');
    return;
  }
  if (!sending.ok) {
    console.log(`\nNothing was deployed: ${DOMAIN} cannot send mail yet (see above).`);
    process.exit(1);
  }

  // the PDF is made with pdf-lib, which the deploy bundles from this folder's own packages
  if (!fs.existsSync(path.join(__dirname, 'node_modules', 'pdf-lib'))) {
    console.log('\nInstalling the service\'s packages (npm ci) ...');
    const i = spawnSync('npm ci --no-audit --no-fund', { shell: true, cwd: __dirname, stdio: 'inherit' });
    if (i.status !== 0) { console.log('\nNOT DEPLOYED: npm ci stopped (see above).'); process.exit(1); }
  }

  console.log(`\nDeploying easypay-mail to ${LIVE} ...\n`);
  const r = wrangler('deploy', true);
  if (r.status !== 0) { console.log('\nNOT DEPLOYED: wrangler stopped (see above). Nothing of EasyPay was changed.'); process.exit(1); }

  // a new address takes a moment to get its certificate
  let after = before;
  for (let i = 0; i < 12; i++) {
    after = healthAnswer(await ask(LIVE + '/health'));
    if (after.ok) break;
    if (i === 0) console.log('\nWaiting for the address to answer (a new one takes a minute or two) ...');
    await sleep(10000);
  }
  console.log(`\n  ${after.ok ? 'ok       ' : 'NOT UP   '}  ${after.words}`);
  console.log(after.ok
    ? '\nDeployed. A till with "Email the Z report" on now asks the address to confirm, and mails each day closing once it has.'
    : '\nDeployed, but the address does not answer yet. Give it a few minutes, then: node cloudflare/mail/deploy.cjs');
  process.exit(after.ok ? 0 : 1);
})();
