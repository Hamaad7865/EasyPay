// assistant-mcp.test.cjs — EasyPay in Claude, release 1a, against the back office running on this PC
// (next dev on port 3000, reading the dev database). It plays Claude's part: the sign-in endpoints, then
// /mcp with a connection's token, the owner's own sentence from the spec, Confirm, history, delete,
// Restore and Start over. Checks M1 to M12. It makes a business of its own and removes it at the end.
// Usage: node db/tests/assistant-mcp.test.cjs   (ASSISTANT_BASE=http://localhost:3000 by default)
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

const BASE = process.env.ASSISTANT_BASE || 'http://localhost:3000';
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + String(extra).slice(0, 220) : ''));
  if (!cond) failures++;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const one = async (sql, p) => (await c.query(sql, p)).rows[0];
  const admin = crypto.randomUUID();
  await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-mcp@example.com') on conflict do nothing`, [admin]);
  const made = (await one(`select platform.create_tenant($1,'MCP Shop','Main','MC1','Owner',$2,'premium') as r`, [admin, crypto.randomUUID()])).r;
  const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;
  let id = 0;
  try {
    await c.query(`update tenants set business_type = 'retail' where id = $1`, [tid]);
    // Kids Corner's shirt, small: Colour, Age, Style, and two spellings of stripe
    const cat = (await one(`insert into categories (tenant_id, name) values ($1, 'Shirt') returning id`, [tid])).id;
    const item = (await one(`insert into items (tenant_id, name, price, category_id, track_stock) values ($1, 'Chemise  Long Sleeve', 67500, $2, true) returning id`, [tid, cat])).id;
    await c.query(`select variants_generate($1,$2,$3,$4::jsonb)`, [tid, item, ['Colour', 'Age', 'Style'], JSON.stringify([['Red', 'Navy Blue'], ['7', '10'], ['stripe']])]);
    await c.query(`update item_variants set price = case when option_values[2] = '7' then 87500 else 97500 end where item_id = $1`, [item]);
    await c.query(`insert into item_variants (tenant_id, item_id, name, price, option_values) values ($1,$2,'Red / 10 / Stripes',97500,'{Red,10,Stripes}')`, [tid, item]);
    const v7 = (await one(`select id from item_variants where item_id = $1 and option_values = '{Red,7,stripe}'`, [item])).id;
    await c.query(`select stock_move($1,$2,$3,$4,2000,'opening',null,null,null,$5,'test')`, [tid, store, item, v7, emp]);

    // a connection, as /oauth/token would leave it
    const token = 'ep_at_test_' + crypto.randomBytes(16).toString('hex');
    await c.query(`insert into assistant_clients (client_id, redirect_uris) values ($1, '{https://claude.ai/api/mcp/auth_callback}')`, ['claude_test_' + tid.slice(0, 8)]);
    const grant = (await one(`insert into assistant_grants (tenant_id, employee_id, client_id, access_hash, access_expires) values ($1,$2,$3,$4, now() + interval '1 hour') returning id`,
      [tid, emp, 'claude_test_' + tid.slice(0, 8), sha(token)])).id;

    const rpc = async (method, params, auth = token) => {
      const r = await fetch(BASE + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(auth ? { authorization: 'Bearer ' + auth } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch { const m = /^data: (.*)$/m.exec(text); body = m ? JSON.parse(m[1]) : text; }
      return { status: r.status, headers: r.headers, body };
    };
    const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).body.result;
    const words = (r) => (r && r.content ? r.content.map((x) => x.text).join('\n') : JSON.stringify(r));

    // M1 the sign-in is found where Claude looks for it
    const none = await rpc('tools/list', {}, null);
    check('M1 /mcp without a token is 401 with where to sign in', none.status === 401 && /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/.test(none.headers.get('www-authenticate') || ''),
      none.headers.get('www-authenticate'));
    const meta = await (await fetch(BASE + '/.well-known/oauth-authorization-server')).json();
    const res = await (await fetch(BASE + '/.well-known/oauth-protected-resource/mcp')).json();
    check('M1 the metadata names the endpoints, S256 only', meta.code_challenge_methods_supported.join() === 'S256' && meta.registration_endpoint.endsWith('/oauth/register')
      && res.resource.endsWith('/mcp') && res.authorization_servers.length === 1, JSON.stringify(meta).slice(0, 120));
    const badReg = await fetch(BASE + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
    const goodReg = await fetch(BASE + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' }) });
    const reg = await goodReg.json();
    check('M1 only Claude\'s callback registers', badReg.status === 400 && goodReg.status === 201 && /^claude_/.test(reg.client_id), `${badReg.status} ${goodReg.status}`);
    const tok = await fetch(BASE + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'nope', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: 'x'.repeat(43) }) });
    check('M1 a made-up code gets no token', tok.status === 400 && (await tok.json()).error === 'invalid_grant', tok.status);
    await c.query(`delete from assistant_clients where client_id = $1`, [reg.client_id]);

    // M2 the tools Claude is given: Confirm and Cancel are the card's only
    const list = (await rpc('tools/list', {})).body.result.tools;
    const names = list.map((t) => t.name);
    const confirmTool = list.find((t) => t.name === 'confirm');
    check('M2 the questions and changes are listed', ['find', 'product', 'stock', 'history', 'add_line', 'change_stock', 'delete', 'start_over'].every((n) => names.includes(n)), names.join(','));
    check('M2 confirm is for the card only', confirmTool && JSON.stringify(confirmTool._meta.ui.visibility) === '["app"]', JSON.stringify(confirmTool && confirmTool._meta));

    // M3 find: "Shirt Long Sleeve" is not a name, so it lists Chemise Long Sleeve and says to ask
    const f = words(await tool('find', { words: 'Shirt Long Sleeve' }));
    check('M3 find lists Chemise Long Sleeve with its id, and says no product is called that', f.includes(item) && f.includes('No product is called exactly'), f);

    // M4 the owner's sentence: red, size 3 - 6m, striped, 5, no price
    let r = await tool('add_line', { product: item, values: { Colour: 'red', Age: '3 - 6m', Style: 'striped' }, qty: 5, asked: 'open stock for Shirt Long Sleeve quantity 5 variant color red, size 3 - 6m, style striped' });
    check('M4 no price said and the lines differ: it asks, nothing is shown', /What price\?/.test(words(r)) && !r.structuredContent, words(r));
    r = await tool('add_line', { product: item, values: { Colour: 'red', Age: '3 - 6m', Style: 'striped' }, qty: 5, price: 875 });
    const html = r.structuredContent && r.structuredContent.html;
    const code = r._meta && r._meta['easypay/code'];
    const proposal = (/data-confirm="([0-9a-f-]{36})"/.exec(html || '') || [])[1];
    check('M4 a card comes back with Confirm, and the code only in _meta', Boolean(html && code && proposal) && !words(r).includes(code), words(r));
    check('M4 striped is read as stripe, 3 - 6m is new', /stripe/.test(words(r)) && /3-6m[^\n]*NEW/.test(words(r)), words(r));
    check('M4 nothing was made yet', !(await one(`select 1 from item_variants where item_id = $1 and option_values[2] = '3-6m'`, [item])));

    // M5 Confirm: not without the code, then with it
    let k = await tool('confirm', { proposal, code: 'guess' });
    check('M5 a confirm without the card\'s code is refused', k.isError === true && /card/.test(words(k)), words(k));
    k = await tool('confirm', { proposal, code });
    const madeLine = await one(`select v.id, v.name, v.price, (select qty from stock_levels l where l.variant_id = v.id) as qty from item_variants v where item_id = $1 and option_values[2] = '3-6m'`, [item]);
    check('M5 with it, Red / 3-6m / stripe is made at Rs 875 with 5 in stock', madeLine && madeLine.name === 'Red / 3-6m / stripe' && Number(madeLine.price) === 87500 && madeLine.qty === 5000, JSON.stringify(madeLine));
    k = await tool('confirm', { proposal, code });
    check('M5 a second confirm of the same card does nothing', k.isError === true, words(k));
    const logged = await one(`select kind, asked from assistant_log where tenant_id = $1 and proposal_id = $2`, [tid, proposal]);
    check('M5 the change is logged', logged && logged.kind === 'add_line', JSON.stringify(logged));

    // M6 product shows a grid; history shows the opening
    r = await tool('product', { product: item });
    check('M6 product answers with its values and counts, and a card with grid cells', /Style: stripe \(\d\), Stripes \(1\)/.test(words(r)) && /data-history=/.test(r.structuredContent.html), words(r));
    r = await tool('history', { line: madeLine.id });
    check('M6 history shows the opening stock', /Opening stock \+5/.test(words(r)), words(r));

    // M7 a change made under a card makes the card stale
    r = await tool('change_stock', { product: item, values: { Colour: 'Red', Age: '7', Style: 'stripe' }, mode: 'add', qty: 1, reason: 'damaged' });
    const p2 = (/data-confirm="([0-9a-f-]{36})"/.exec(r.structuredContent.html) || [])[1], c2 = r._meta['easypay/code'];
    await c.query(`select stock_move($1,$2,$3,$4,1000,'found',null,null,null,$5,'meanwhile')`, [tid, store, item, v7, emp]);
    k = await tool('confirm', { proposal: p2, code: c2 });
    check('M7 stock that moved since the card refuses the confirm', k.isError === true && /changed since/.test(words(k)), words(k));

    // M8 a delete: a red card, the shop's name to type; then Restore
    r = await tool('delete', { what: 'lines', product: item, ids: [madeLine.id] });
    check('M8 a delete is red and names what goes', /danger|red/.test(r.structuredContent.html) && /written off/.test(r.structuredContent.html), words(r));
    const p3 = (/data-confirm="([0-9a-f-]{36})"/.exec(r.structuredContent.html) || [])[1], c3 = r._meta['easypay/code'];
    k = await tool('confirm', { proposal: p3, code: c3 });
    const gone = await one(`select deleted_at is not null as gone, (select qty from stock_levels l where l.variant_id = v.id) as qty from item_variants v where id = $1`, [madeLine.id]);
    check('M8 the line is hidden and its stock written off', gone.gone && gone.qty === 0, JSON.stringify(gone));
    const logId = (await one(`select id from assistant_log where tenant_id = $1 and kind = 'delete'`, [tid])).id;
    r = await tool('restore', { change: logId });
    const p4 = (/data-confirm="([0-9a-f-]{36})"/.exec(r.structuredContent.html) || [])[1], c4 = r._meta['easypay/code'];
    await tool('confirm', { proposal: p4, code: c4 });
    const back = await one(`select deleted_at is null as here, (select qty from stock_levels l where l.variant_id = v.id) as qty from item_variants v where id = $1`, [madeLine.id]);
    check('M8 Restore brings the line and its 5 back', back.here && back.qty === 5000, JSON.stringify(back));

    // M9 a sub category, then a product with no options and its opening stock (the owner's first example)
    r = await tool('edit_category', { verb: 'new', name: 'long sleeve', under: 'Shirt' });
    await tool('confirm', { proposal: (/data-confirm="([0-9a-f-]{36})"/.exec(r.structuredContent.html) || [])[1], code: r._meta['easypay/code'] });
    r = await tool('edit_product', { verb: 'new', name: 'Plain Shirt', category: 'Shirt › Long Sleeve', price: 500, qty: 6 });
    await tool('confirm', { proposal: (/data-confirm="([0-9a-f-]{36})"/.exec(r.structuredContent.html) || [])[1], code: r._meta['easypay/code'] });
    const plain = await one(`select i.id, k.name as cat, p.name as parent, (select qty from stock_levels l where l.item_id = i.id and l.variant_id is null) as qty
                               from items i join categories k on k.id = i.category_id join categories p on p.id = k.parent_id where i.tenant_id = $1 and i.name = 'Plain Shirt'`, [tid]);
    check('M9 Plain Shirt is in Shirt › Long Sleeve with 6 in stock', plain && plain.cat === 'Long Sleeve' && plain.parent === 'Shirt' && plain.qty === 6000, JSON.stringify(plain));

    // M10 start over, while being set up; refused for a live shop
    r = await tool('start_over', {});
    check('M10 start over asks for the shop\'s name', /data-type-name="MCP Shop"/.test(r.structuredContent.html), words(r));
    await tool('confirm', { proposal: (/data-confirm="([0-9a-f-]{36})"/.exec(r.structuredContent.html) || [])[1], code: r._meta['easypay/code'] });
    const left = await one(`select count(*)::int as n from items where tenant_id = $1 and deleted_at is null`, [tid]);
    check('M10 every product is hidden', left.n === 0, left.n);
    await c.query(`delete from platform.setting_up where tenant_id = $1`, [tid]);
    r = await tool('start_over', {});
    check('M10 a live shop can\'t start over', r.isError === true && /live/.test(words(r)), words(r));

    // M11 another business's product is not there
    const other = (await one(`select i.id from items i where i.tenant_id <> $1 and i.deleted_at is null limit 1`, [tid]));
    if (other) {
      r = await tool('product', { product: other.id });
      check('M11 another business\'s product is not found', r.isError === true, words(r));
    }

    // M13 the sign-in that works: a code for tokens, the token on /mcp, a refresh, the old refresh refused, Disconnect
    {
      const regd = await (await fetch(BASE + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) })).json();
      const verifier = crypto.randomBytes(40).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const codeIs = crypto.randomBytes(24).toString('base64url');
      await c.query(`insert into assistant_codes (code_hash, client_id, tenant_id, employee_id, redirect_uri, challenge, expires_at) values ($1,$2,$3,$4,'https://claude.ai/api/mcp/auth_callback',$5, now() + interval '5 minutes')`,
        [sha(codeIs), regd.client_id, tid, emp, challenge]);
      const post = (body) => fetch(BASE + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
      let t = await post({ grant_type: 'authorization_code', code: codeIs, client_id: regd.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier });
      const first = await t.json();
      check('M13 a good code and verifier give tokens', t.status === 200 && /^ep_at_/.test(first.access_token) && /^ep_rt_/.test(first.refresh_token), JSON.stringify(first).slice(0, 80));
      const used = await rpc('tools/list', {}, first.access_token);
      check('M13 the access token works on /mcp', used.status === 200 && Array.isArray(used.body.result.tools), used.status);
      t = await post({ grant_type: 'authorization_code', code: codeIs, client_id: regd.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier });
      check('M13 a code works once', t.status === 400, t.status);
      t = await post({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: regd.client_id });
      const second = await t.json();
      check('M13 a refresh gives a new pair', t.status === 200 && second.refresh_token !== first.refresh_token, t.status);
      t = await post({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: regd.client_id });
      check('M13 the old refresh token is refused', t.status === 400, t.status);
      await c.query(`update assistant_grants set ended_at = now(), ended_why = 'disconnected' where tenant_id = $1 and client_id = $2`, [tid, regd.client_id]);
      check('M13 after Disconnect, /mcp is 401', (await rpc('tools/list', {}, second.access_token)).status === 401);
      await c.query(`delete from assistant_clients where client_id = $1`, [regd.client_id]);
    }

    // M14 what Claude asks first: initialize, then the card's page
    {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, clientInfo: { name: 'test', version: '1' } });
      check('M14 initialize answers, with EasyPay\'s instructions', init.status === 200 && init.body.result && /EasyPay/.test(init.body.result.instructions || ''), JSON.stringify(init.body).slice(0, 160));
      const page = await rpc('resources/read', { uri: 'ui://easypay/card' });
      const content = page.body.result && page.body.result.contents[0];
      check('M14 the card page is an MCP App with the bridge in it', content && content.mimeType === 'text/html;profile=mcp-app' && /ui\/initialize/.test(content.text), JSON.stringify(page.body).slice(0, 160));
    }

    // M12 losing Use the assistant ends the connection
    await c.query(`update roles set permissions = '[]'::jsonb where id = (select role_id from employees where id = $1)`, [emp]);
    const after = await rpc('tools/list', {});
    const ended = await one(`select ended_why from assistant_grants where id = $1`, [grant]);
    check('M12 a login that lost the permission is signed out of Claude', after.status === 401 && ended.ended_why === 'no-permission', `${after.status} ${ended.ended_why}`);
  } finally {
    await devguard.cleanupTenant(c, tid).catch((e) => console.log('cleanup: ' + e.message));
    await c.query(`delete from assistant_clients where client_id = $1`, ['claude_test_' + tid.slice(0, 8)]).catch(() => {});
    await c.end();
  }
  console.log(failures === 0 ? 'ASSISTANT MCP PASS' : `ASSISTANT MCP FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
