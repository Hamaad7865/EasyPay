// assistant-sweep.test.cjs — EasyPay in Claude, the fixes of the 2026-11-03 bug sweep
// (docs/superpowers/reviews/2026-11-03-bug-sweep.md), against the back office on this PC (next dev, port
// 3000, the dev database). Checks W1 to W6:
//   W1 a split's products hold their pieces in their totals, and Restore gives them back (0152)
//   W2 a promoted line takes its promotion to the product it goes to (0152)
//   W3 a change is restored once: a second card for it is refused at Confirm
//   W4 an import in a shop of two branches asks which, and a line's stock at the other is left alone
//   W5 a plan that makes a category and moves a product into it confirms (each step planned again)
//   W6 an owner's role is not changed through Claude
// It makes a business of its own and removes it at the end.
// Usage: node db/tests/assistant-sweep.test.cjs   (ASSISTANT_BASE=http://localhost:3000 by default)
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

const BASE = process.env.ASSISTANT_BASE || 'http://localhost:3000';
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + String(extra).slice(0, 240) : ''));
  if (!cond) failures++;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const one = async (sql, p) => (await c.query(sql, p)).rows[0];
  const all = async (sql, p) => (await c.query(sql, p)).rows;
  const admin = crypto.randomUUID();
  await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-sweep@example.com') on conflict do nothing`, [admin]);
  const made = (await one(`select platform.create_tenant($1,'Sweep Shop','Main','SW1','Owner',$2,'premium') as r`, [admin, crypto.randomUUID()])).r;
  const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;
  const client = 'claude_test_' + tid.slice(0, 8);
  let id = 0;
  try {
    await c.query(`update tenants set business_type = 'retail' where id = $1`, [tid]);
    const token = 'ep_at_test_' + crypto.randomBytes(16).toString('hex');
    await c.query(`insert into assistant_clients (client_id, redirect_uris) values ($1, '{https://claude.ai/api/mcp/auth_callback}')`, [client]);
    await c.query(`insert into assistant_grants (tenant_id, employee_id, client_id, access_hash, access_expires) values ($1,$2,$3,$4, now() + interval '1 hour')`, [tid, emp, client, sha(token)]);
    const tool = async (name, args) => {
      const r = await fetch(BASE + '/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', authorization: 'Bearer ' + token },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      });
      const text = await r.text();
      try { return JSON.parse(text).result; } catch { const m = /^data: (.*)$/m.exec(text); return m ? JSON.parse(m[1]).result : { content: [{ text }] }; }
    };
    const words = (r) => (r && r.content ? r.content.map((x) => x.text).join('\n') : JSON.stringify(r));
    const press = async (r) => tool('confirm', { proposal: (/data-confirm="([0-9a-f-]{36})"/.exec((r.structuredContent || {}).html || '') || [])[1], code: (r._meta || {})['easypay/code'] });
    // a product's total against what its lines hold at every branch
    const totals = async () => (await all(
      `select i.name, coalesce(i.stock_qty, 0)::float8 as total,
              (select coalesce(sum(l.qty), 0) from stock_levels l where l.tenant_id = i.tenant_id and l.item_id = i.id)::float8 as held
         from items i where i.tenant_id = $1 and i.deleted_at is null order by i.name`, [tid]))
      // a product emptied by a split, whether or not it is taken away, shows only if it still counts something
      .filter((x) => x.total || x.held).map((x) => `${x.name}:${x.total / 1000}/${x.held / 1000}`).join(' ');

    // the shop's shirt: Colour and Style, 9 pieces, one line on promotion
    const item = (await one(`insert into items (tenant_id, name, price, track_stock, option_names) values ($1, 'Chemise', 50000, true, '{Colour,Style}') returning id`, [tid])).id;
    const lineOf = {};
    for (const [col, sty, q] of [['White', 'Plain', 4], ['Red', 'Plain', 2], ['White', 'Stripe', 3]]) {
      const v = (await one(`insert into item_variants (tenant_id, item_id, name, price, option_values) values ($1,$2,$3,50000,$4) returning id`, [tid, item, `${col} / ${sty}`, [col, sty]])).id;
      lineOf[`${col}/${sty}`] = v;
      await c.query(`select stock_move($1,$2,$3,$4,$5,'opening',null,null,null,$6,'test')`, [tid, store, item, v, q * 1000, emp]);
    }
    await c.query(`insert into promotions (tenant_id, item_id, variant_id, original_price, promo_price) values ($1,$2,$3,50000,40000)`, [tid, item, lineOf['White/Stripe']]);
    check('W0 (the shirt holds 9 in its total)', (await totals()) === 'Chemise:9/9', await totals());

    // W1 split by Style: each product's total is what its lines hold
    let r = await tool('split', { product: item, by: 'Style', names: { Plain: 'Chemise Plain', Stripe: 'Chemise Stripe' } });
    let k = await press(r);
    check('W1 split: Chemise Plain 6 and Chemise Stripe 3, in their totals as in their lines', (await totals()) === 'Chemise Plain:6/6 Chemise Stripe:3/3', (await totals()) + ' ' + words(k));
    const was = (await one(`select coalesce(stock_qty, 0)::float8 as q from items where id = $1`, [item])).q;
    check('W1 and Chemise, emptied, holds nothing in its total', was === 0, was);

    // W2 the promoted line's promotion is the new product's
    const promo = await one(`select p.item_id, i.name from promotions p join items i on i.id = p.item_id where p.tenant_id = $1 and p.variant_id = $2`, [tid, lineOf['White/Stripe']]);
    check('W2 the promotion of White / Stripe went with it to Chemise Stripe', promo && promo.name === 'Chemise Stripe', JSON.stringify(promo));

    // W1 Restore: the totals go back
    const log = (await one(`select id from assistant_log where tenant_id = $1 and kind = 'split' order by created_at desc limit 1`, [tid])).id;
    const card1 = await tool('restore', { change: log });
    const card2 = await tool('restore', { change: log });
    check('W3 (two cards to restore the same split, drawn before either is pressed)', !!(card1.structuredContent && card2.structuredContent), words(card1) + ' | ' + words(card2));
    k = await press(card1);
    check('W1 Restore: Chemise holds its 9 again, in its total as in its lines', (await totals()) === 'Chemise:9/9', (await totals()) + ' ' + words(k));
    const back = await one(`select i.name from promotions p join items i on i.id = p.item_id where p.tenant_id = $1 and p.variant_id = $2`, [tid, lineOf['White/Stripe']]);
    check('W2 and its promotion is Chemise\'s again', back && back.name === 'Chemise', JSON.stringify(back));

    // W3 the second card is refused, and changes nothing
    k = await press(card2);
    check('W3 the same change is not restored twice', k.isError === true && /already restored/.test(words(k)), words(k));
    check('W3 nothing moved', (await totals()) === 'Chemise:9/9', await totals());

    // W4 a second branch: an import asks which, and a line held only there is not touched
    const second = (await one(`select platform.add_store($1, $2, 'Second', 'SW2') as id`, [admin, tid])).id;
    const tee = (await one(`insert into items (tenant_id, name, price, track_stock, option_names) values ($1, 'Tee', 30000, true, '{Size}') returning id`, [tid])).id;
    const six = (await one(`insert into item_variants (tenant_id, item_id, name, price, option_values) values ($1,$2,'6',30000,'{6}') returning id`, [tid, tee])).id;
    await c.query(`select stock_move($1,$2,$3,$4,5000,'opening',null,null,null,$5,'test')`, [tid, second, tee, six, emp]);
    const rows = [{ n: 2, name: 'Tee', price: 300, stock: 3, options: { Size: '6' } }];
    r = await tool('import', { rows });
    check('W4 with two branches, the import asks which branch', !r.structuredContent && /branch/i.test(words(r)) && /Second/.test(words(r)), words(r));
    r = await tool('import', { rows, branch: 'Main' });
    check('W4 at Main, where the line holds nothing, it is not asked whether to add or replace', !!r.structuredContent && !/already hold stock/.test(words(r)), words(r));
    k = await press(r);
    const at = async (st) => Number((await one(`select coalesce((select qty from stock_levels where tenant_id = $1 and variant_id = $2 and store_id = $3), 0) as q`, [tid, six, st])).q) / 1000;
    check('W4 Main holds the file\'s 3, Second still its 5', (await at(store)) === 3 && (await at(second)) === 5, `${await at(store)} ${await at(second)} ${words(k)}`);
    r = await tool('import', { rows: [{ n: 2, name: 'Tee', price: 300, stock: 4, options: { Size: '6' } }], branch: 'Second', existing: 'set' });
    k = await press(r);
    check('W4 set at Second: 4 there, Main still 3', (await at(second)) === 4 && (await at(store)) === 3, `${await at(store)} ${await at(second)} ${words(k)}`);

    // W5 a plan: a new category, then a product moved into it
    r = await tool('plan', {
      steps: [
        { tool: 'edit_category', args: { verb: 'new', name: 'Sweep Tops' } },
        { tool: 'edit_product', args: { verb: 'edit', product: tee, category: 'Sweep Tops' } },
      ],
      asked: 'a category for the tees',
    });
    check('W5 (the plan is one card)', !!r.structuredContent, words(r));
    k = await press(r);
    const into = await one(`select k.name from items i join categories k on k.id = i.category_id and k.deleted_at is null where i.id = $1`, [tee]);
    check('W5 confirmed, Tee is in the category the plan made', !k.isError && into && into.name === 'Sweep Tops', JSON.stringify(into) + ' ' + words(k));

    // W6 another owner's role stays
    const ownerRole = (await one(`select role_id from employees where id = $1`, [emp])).role_id;
    const other = (await one(`select name from roles where tenant_id = $1 and deleted_at is null and not (permissions ? '*') order by name limit 1`, [tid]));
    await c.query(`insert into employees (tenant_id, name, role_id) values ($1, 'Partner', $2)`, [tid, ownerRole]);
    r = await tool('edit_staff', { staff: 'Partner', role: other ? other.name : 'Cashier' });
    check('W6 an owner\'s role is not changed through Claude', r.isError === true && /is an owner/.test(words(r)), words(r));
  } finally {
    await devguard.cleanupTenant(c, tid).catch((e) => console.log('cleanup: ' + e.message));
    await c.query(`delete from assistant_clients where client_id = $1`, [client]).catch(() => {});
    await c.end();
  }
  console.log(failures === 0 ? 'ASSISTANT SWEEP PASS' : `ASSISTANT SWEEP FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
