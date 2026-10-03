// webenv.cjs — regenerate web/.env.local from the linked branch.
// Usage: node db/scripts/webenv.cjs   (run from repo root)
// Copies pooled DATABASE_URL + auth/function URLs from root .env.local
// (written by `neon link` / `neon deploy`), preserving the existing
// NEON_AUTH_COOKIE_SECRET or minting one. Never commit the output.
const fs = require('fs');
function load(file) {
  const env = {};
  const strip = (v) => { v = v.trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('='); env[t.slice(0, i).trim()] = strip(t.slice(i + 1));
  }
  return env;
}
const root = load('.env.local');
let secret = null;
try {
  const cur = load('web/.env.local');
  if (cur.NEON_AUTH_COOKIE_SECRET && cur.NEON_AUTH_COOKIE_SECRET.length >= 32) secret = cur.NEON_AUTH_COOKIE_SECRET;
} catch {}
if (!secret) secret = require('crypto').randomBytes(32).toString('base64');
const out = [
  `DATABASE_URL=${root.DATABASE_URL}`,
  `NEON_AUTH_BASE_URL=${root.NEON_AUTH_BASE_URL}`,
  `NEON_AUTH_COOKIE_SECRET=${secret}`,
  `NEXT_PUBLIC_FUNCTION_URL=${root.NEON_FUNCTION_API_BASE_URL}`,
].join('\n') + '\n';
fs.writeFileSync('web/.env.local', out);
console.log('web/.env.local regenerated from branch ' + (root.NEON_BRANCH || '?'));
