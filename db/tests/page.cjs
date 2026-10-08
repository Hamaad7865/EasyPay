// page.cjs — opens a back office page without a browser and without a login.
// The page is the real one, compiled from the TypeScript it lives in; only
// what Next and the sign-in give it is stood in for: who is signed in (the
// caller says), and the database connection (the caller's own, inside the
// caller's transaction, as the tenant's role). So a page that nobody can
// open on dev without an account still has its own queries run, and what it
// would show can be read.
//   const { open, text, rowsOf, stats } = require('./page.cjs');
//   const html = await open(client, ctx, '/backoffice/reports/sales', { from: '2026-10-08' });
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web');
const ts = require(path.join(WEB, 'node_modules', 'typescript'));
const React = require(path.join(WEB, 'node_modules', 'react'));
const { renderToStaticMarkup } = require(path.join(WEB, 'node_modules', 'react-dom', 'server'));

function loader(client, ctx, route) {
  // the page's transaction: the tenant's role and the tenant, as web/lib/db.ts opens one
  const asTenant = async (tenantId, fn) => {
    if (tenantId !== ctx.tenantId) throw new Error('a page asked for another tenant: ' + tenantId);
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    try { return await fn(client); } finally { await client.query('RESET ROLE'); }
  };
  const icon = () => null;
  const stubs = {
    'next/link': { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement('a', { href, ...rest }, children), useLinkStatus: () => ({ pending: false }) },
    'next/navigation': {
      usePathname: () => route, useRouter: () => ({ push() {}, refresh() {}, replace() {} }), useSearchParams: () => new URLSearchParams(),
      redirect: (to) => { throw new Error('redirect ' + to); }, notFound: () => { throw new Error('not found'); }, unstable_rethrow() {},
    },
    'next/cache': { revalidatePath() {} },
    '@/lib/tenant': {
      tenantContext: async () => ctx, requirePerm: async () => ctx, isSuspended: () => false,
      onlyFor: async (mode) => { if (ctx.mode !== mode) throw new Error('not found'); return ctx; },
    },
    '@/lib/db': { readTenant: asTenant, withTenant: asTenant, ask: (sql, params) => client.query(sql, params) },
    'lucide-react': new Proxy({}, { get: () => icon }),
  };
  const cache = {};
  const resolve = (base) => {
    for (const ext of ['.ts', '.tsx']) if (fs.existsSync(base + ext)) return base + ext;
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
    throw new Error('cannot resolve ' + base);
  };
  function load(file) {
    if (cache[file]) return cache[file].exports;
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
    }).outputText;
    const mod = { exports: {} };
    cache[file] = mod;
    const req = (name) => {
      if (stubs[name]) return stubs[name];
      if (name === 'react' || name === 'react-dom' || name.startsWith('react/') || name.startsWith('react-dom/')) return require(path.join(WEB, 'node_modules', name));
      if (name.startsWith('@/')) return load(resolve(path.join(WEB, name.slice(2))));
      if (name.startsWith('.')) return name.endsWith('.css') ? {} : load(resolve(path.join(path.dirname(file), name)));
      if (name === 'pg') return {};
      if (name.startsWith('node:')) return require(name);
      throw new Error('an import this test has no stand-in for: ' + name + ' in ' + file);
    };
    new Function('require', 'module', 'exports', js)(req, mod, mod.exports);
    return mod.exports;
  }
  return load;
}

// The page at `href` (as the menu links to it), for the person `ctx`:
// { tenantId, employeeId, mode, ... }. `sp` are the address's ?parameters,
// `params` the [id] parts of a page that has them (then `file` names it).
async function open(client, ctx, href, sp = {}, { params, file } = {}) {
  const who = { userId: 'test', role: 'Owner', status: 'active', statusReason: null, tenantName: 'Test', employeeName: 'Owner', ...ctx };
  const load = loader(client, who, href);
  const Page = load(path.join(WEB, 'app', file ?? href.replace(/^\//, ''), 'page.tsx')).default;
  const props = { searchParams: Promise.resolve(sp) };
  if (params) props.params = Promise.resolve(params);
  // a page may hand over to another async server component (Next resolves those; a static render cannot)
  let el = await Page(props);
  while (el && typeof el.type === 'function' && el.type.constructor.name === 'AsyncFunction') el = await el.type(el.props);
  return renderToStaticMarkup(el);
}

// what a page says, without its markup
const text = (html) => html.replace(/<!-- -->/g, '').replace(/<(script|style)[^>]*>.*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
// each table row as "cell | cell | cell"
const rowsOf = (html) => [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((c) => text(c[1])).join(' | '));
// the figures at the top of a report, as "label: value"
const stats = (html) => [...html.matchAll(/<div class="stat-label">(.*?)<\/div><div class="stat-value"[^>]*>(.*?)<\/div>/g)].map((m) => text(m[1]) + ': ' + text(m[2]));

module.exports = { open, text, rowsOf, stats };
