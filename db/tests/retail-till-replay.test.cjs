// retail-till-replay.test.cjs — what a till of build 3 really sent, as a shop
// and as a restaurant. Each fixture is the outbox, receipts and stock figures
// of the Android build after a run on an emulator with the debug build's
// made-up business:
//   the shop: a sale with a variant, a weighed product and a line discount,
//     parked and brought back; a part return not put back into stock; a price
//     changed with a manager's PIN; a sale with a typed quantity, rupees off a
//     line, a note, a removed line, a customer and a discount on the sale;
//   the restaurant (the same build, the same catalog): a table seated, a
//     quantity changed the restaurant's way, sent to the kitchen and paid; a
//     quick sale paid by card; a refund.
// The server must take every operation and end up with the till's figures.
// It keeps the server honest about that build: a change to a push function
// that would refuse or re-price what build 3 sends fails here.
// Each runs in ONE transaction that is rolled back (db/scripts/replay-demo-outbox.cjs).
// Usage: node db/tests/retail-till-replay.test.cjs
const path = require('path');
const { spawnSync } = require('child_process');
let failed = 0;
for (const [what, file, extra] of [['shop', 'demo-till-build3.json', []], ['restaurant', 'demo-till-build3-restaurant.json', ['restaurant']]]) {
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'replay-demo-outbox.cjs'), path.join(__dirname, 'fixtures', file), ...extra], { encoding: 'utf8' });
  process.stdout.write(out.stdout.split('\n').filter((l) => /^(PASS|FAIL|REPLAY)/.test(l)).map((l) => (/^REPLAY/.test(l) ? l : l.replace(/^(PASS|FAIL) /, `$1 ${what}: `)).slice(0, 170)).join('\n') + '\n');
  if (out.status !== 0) { failed++; process.stderr.write(out.stderr.split('\n').filter((l) => /REPLAY_FAILED|Error/.test(l)).join('\n') + '\n'); }
}
process.exit(failed ? 1 : 0);
