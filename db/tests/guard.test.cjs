// guard.test.cjs — the test guard refuses production by label AND by host,
// without opening a connection. Usage: node db/tests/guard.test.cjs
const devguard = require('./require-dev.cjs');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const refuses = (env) => { try { devguard.requireDev(env); return false; } catch { return true; } };
const dev = 'postgresql://u:p@ep-some-dev-branch.c-4.ap-southeast-1.aws.neon.tech/neondb';
const prod = 'postgresql://u:p@ep-soft-poetry-b3lyjmxs-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb';
check('dev label + dev hosts runs', !refuses({ NEON_BRANCH: 'dev-review', DATABASE_URL: dev, DATABASE_URL_UNPOOLED: dev }));
check('production label refused', refuses({ NEON_BRANCH: 'production', DATABASE_URL: dev }));
check('missing label refused', refuses({ DATABASE_URL: dev }));
check('dev label + production pooled host refused', refuses({ NEON_BRANCH: 'dev-review', DATABASE_URL: prod, DATABASE_URL_UNPOOLED: dev }));
check('dev label + production unpooled host refused', refuses({ NEON_BRANCH: 'dev-review', DATABASE_URL: dev, DATABASE_URL_UNPOOLED: prod.replace('-pooler', '') }));
console.log(failures === 0 ? 'GUARD PASS' : `GUARD FAIL (${failures})`);
process.exit(failures ? 1 : 0);
