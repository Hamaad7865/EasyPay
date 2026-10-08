// retail-till-replay.test.cjs — what a shop's till really sent. The fixture is
// the outbox, receipts and stock figures of the Android build (3) after a run
// on an emulator with the debug build's made-up shop: a sale with a variant,
// a weighed product and a line discount, parked and brought back; a part
// return not put back into stock; a price changed with a manager's PIN; a
// sale with a typed quantity, rupees off a line, a note, a removed line, a
// customer and a discount on the whole sale. The server must take every
// operation and end up with the till's figures.
// It keeps the server honest about that build: a change to a push function
// that would refuse or re-price what build 3 sends fails here.
// Runs in ONE transaction that is rolled back (db/scripts/replay-demo-outbox.cjs).
// Usage: node db/tests/retail-till-replay.test.cjs
const path = require('path');
const { spawnSync } = require('child_process');
const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'replay-demo-outbox.cjs'), path.join(__dirname, 'fixtures', 'demo-till-build3.json')], { encoding: 'utf8' });
process.stdout.write(out.stdout.split('\n').filter((l) => /^(PASS|FAIL|REPLAY)/.test(l)).map((l) => l.slice(0, 160)).join('\n') + '\n');
if (out.status !== 0) process.stderr.write(out.stderr.split('\n').filter((l) => /REPLAY_FAILED|Error/.test(l)).join('\n') + '\n');
process.exit(out.status ?? 1);
