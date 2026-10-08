// backoffice-plan.test.cjs — which back office pages a plan has. Bookings is a
// page of the premium tier (0085): a restaurant on another plan does not find
// it in the menu or in the search, and a shop never has it. The menu and the
// search both read backoffice/nav.ts, so this asks that file. No database.
// Usage: node db/tests/backoffice-plan.test.cjs
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

// a TypeScript file of the back office, compiled as it stands; its icons are
// stood in for by their names
const web = path.join(__dirname, '..', '..', 'web');
const ts = require(path.join(web, 'node_modules', 'typescript'));
function load(file) {
  const js = ts.transpileModule(fs.readFileSync(path.join(web, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const req = (id) => (id === 'lucide-react' ? new Proxy({}, { get: (_, k) => String(k) }) : require(id));
  new Function('require', 'module', 'exports', js)(req, mod, mod.exports);
  return mod.exports;
}

const plan = load('lib/plan.ts');
const nav = load('app/backoffice/nav.ts');
const hrefs = (mode, premium) => nav.groupsFor(mode, premium).flatMap((g) => g.links.map((l) => l.href));
const BOOKINGS = '/backoffice/bookings';

check('N1 premium and trial carry the premium pages, however the plan was typed',
  plan.hasPremium('premium') && plan.hasPremium('trial') && plan.hasPremium(' Premium '));
check('N1 standard, free, nothing and anything else do not',
  !plan.hasPremium('standard') && !plan.hasPremium('free') && !plan.hasPremium(null) && !plan.hasPremium(undefined) && !plan.hasPremium('gold'));

check('N2 a premium restaurant has Bookings in its menu', hrefs('restaurant', true).includes(BOOKINGS));
check('N2 a standard restaurant does not', !hrefs('restaurant', false).includes(BOOKINGS));
check('N2 and loses nothing else', hrefs('restaurant', true).filter((h) => h !== BOOKINGS).join() === hrefs('restaurant', false).join());
check('N3 a shop has no Bookings on any plan', !hrefs('retail', true).includes(BOOKINGS) && !hrefs('retail', false).includes(BOOKINGS));
check('N3 and a shop\'s menu does not depend on its plan', hrefs('retail', true).join() === hrefs('retail', false).join());

const found = (mode, premium) => nav.pagesOf(mode, premium).some((p) => p.href === BOOKINGS);
check('N4 the search finds Bookings for a premium restaurant only', found('restaurant', true) && !found('restaurant', false) && !found('retail', true));
check('N5 the Bookings address lights no group for a restaurant that does not have it',
  nav.groupOf(BOOKINGS, 'restaurant', true) === 'restaurant' && nav.groupOf(BOOKINGS, 'restaurant', false) === null);

console.log(failures === 0 ? 'BACKOFFICE PLAN PASS' : `BACKOFFICE PLAN FAIL (${failures})`);
process.exit(failures ? 1 : 0);
