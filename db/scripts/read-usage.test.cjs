// read-usage.test.cjs — what db/scripts/read-usage.cjs makes of Neon's
// answers, with no database and no Neon: the answers are written out here.
// Usage: node db/scripts/read-usage.test.cjs
const assert = require('assert');
const { reading, awake, branchNamed } = require('./read-usage.cjs');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); }
}

// as GET /projects/<id> answers, less what the script does not read
const project = () => ({ project: {
  id: 'proj-one', compute_time_seconds: 10976, active_time_seconds: 43452, data_transfer_bytes: 108181448,
  branch_logical_size_limit_bytes: 1073741824,
  consumption_period_start: '2026-10-08T18:31:21Z', consumption_period_end: '2026-11-01T00:00:00Z',
  owner: { branches_limit: 10, subscription_type: 'free_v3' },
} });
// as GET /projects/<id>/branches answers
const branches = () => ({ branches: [
  { id: 'br-prod', name: 'production', default: true, compute_time_seconds: 4256, active_time_seconds: 16864, logical_size: 48889856, written_data_bytes: 0 },
  { id: 'br-dev', name: 'dev-review', default: false, compute_time_seconds: 6720, active_time_seconds: 26588, logical_size: 72466432 },
  { id: 'br-copy', name: 'production-before-launch', default: false, compute_time_seconds: 0, active_time_seconds: 0, logical_size: 39690240 },
] });
// as GET /projects/<id>/endpoints answers
const endpoints = () => ({ endpoints: [
  { branch_id: 'br-dev', type: 'read_only', current_state: 'active' },
  { branch_id: 'br-prod', type: 'read_write', current_state: 'idle' },
  { branch_id: 'br-dev', type: 'read_write', current_state: 'active' },
] });
const NOW = new Date('2026-10-09T19:00:00Z');

check('a reading says what Neon said, and when it was read', () => {
  assert.deepStrictEqual(reading(project(), branches(), NOW), {
    project_id: 'proj-one',
    read_at: '2026-10-09T19:00:00.000Z',
    period_start: '2026-10-08T18:31:21Z',
    period_end: '2026-11-01T00:00:00Z',
    plan: 'free_v3',
    compute_seconds: 10976,
    active_seconds: 43452,
    storage_limit_bytes: 1073741824,
    branches_limit: 10,
    branches: [
      { name: 'production', default: true, compute_seconds: 4256, active_seconds: 16864, logical_size: 48889856 },
      { name: 'dev-review', default: false, compute_seconds: 6720, active_seconds: 26588, logical_size: 72466432 },
      { name: 'production-before-launch', default: false, compute_seconds: 0, active_seconds: 0, logical_size: 39690240 },
    ],
  });
});

check('an answer without a figure the page needs stops it, naming the figure and never a value', () => {
  for (const key of ['compute_time_seconds', 'active_time_seconds', 'consumption_period_start']) {
    const p = project();
    delete p.project[key];
    assert.throws(() => reading(p, branches(), NOW), (e) => e.message.includes(key) && !/\d{4,}/.test(e.message), key);
  }
  const b = branches();
  delete b.branches[1].compute_time_seconds;
  assert.throws(() => reading(project(), b, NOW), /compute_time_seconds/);
  assert.throws(() => reading(project(), { branches: [] }, NOW), /branches/);
  assert.throws(() => reading({}, branches(), NOW), /project/);
});

check('what Neon leaves out without harm is left empty', () => {
  const p = project();
  delete p.project.owner;
  delete p.project.consumption_period_end;
  delete p.project.branch_logical_size_limit_bytes;
  const b = branches();
  delete b.branches[2].logical_size;
  const r = reading(p, b, NOW);
  assert.strictEqual(r.plan, null);
  assert.strictEqual(r.branches_limit, null);
  assert.strictEqual(r.period_end, null);
  assert.strictEqual(r.storage_limit_bytes, null);
  assert.strictEqual(r.branches[2].logical_size, null);
});

check('a branch is found by its name', () => {
  assert.strictEqual(branchNamed(branches(), 'dev-review').id, 'br-dev');
  assert.throws(() => branchNamed(branches(), 'nowhere'), /nowhere/);
});

check('a branch is awake when the compute that writes to it is active', () => {
  assert.strictEqual(awake(endpoints(), 'br-dev'), true);
  assert.strictEqual(awake(endpoints(), 'br-prod'), false);
  // a branch with no compute at all (a restore copy) is asleep
  assert.strictEqual(awake(endpoints(), 'br-copy'), false);
  // one that only reads does not make it awake for a write
  assert.strictEqual(awake({ endpoints: [{ branch_id: 'br-x', type: 'read_only', current_state: 'active' }] }, 'br-x'), false);
});

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall passed');
