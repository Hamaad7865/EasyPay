// assistant-reshape.test.cjs — EasyPay in Claude, release 1b, against the back office on this PC (next dev,
// port 3000, the dev database): a small copy of Kids Corner's shirt with its spellings, tidied, split
// by Style into Shirt › Long Sleeve with Age renamed Size, all as one plan; then Restore; then a file's
// rows imported; then a product counted by size alone given its colours, and Restore. Checks R1 to R10.
// It makes a business of its own and removes it at the end.
// Usage: node db/tests/assistant-reshape.test.cjs   (ASSISTANT_BASE=http://localhost:3000 by default)
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
  await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-reshape@example.com') on conflict do nothing`, [admin]);
  const made = (await one(`select platform.create_tenant($1,'Reshape Shop','Main','RS1','Owner',$2,'premium') as r`, [admin, crypto.randomUUID()])).r;
  const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;
  const client = 'claude_test_' + tid.slice(0, 8);
  let id = 0;
  try {
    await c.query(`update tenants set business_type = 'retail' where id = $1`, [tid]);
    const cat = (await one(`insert into categories (tenant_id, name) values ($1, 'Shirt') returning id`, [tid])).id;
    const item = (await one(`insert into items (tenant_id, name, price, category_id, track_stock, option_names) values ($1, 'Chemise  Long Sleeve', 67500, $2, true, '{Colour,Age,Style}') returning id`, [tid, cat])).id;
    // the spellings as the shop has them: white / White, stripe / Stripes, and one pair that becomes the same line
    const rows = [
      ['white', '3', 'stripe', 2], ['White', '4', 'stripe', 1], ['White', '3', 'Plain', 3], ['white', '4', 'plain', 1],
      ['Red', '7', 'Stripes', 1], ['Red', '7', 'Design', 2], ['red', '8', 'design', 1], ['White', '3', 'Stripes', 1],
    ];
    for (const [i, [col, age, sty, q]] of rows.entries()) {
      const v = (await one(`insert into item_variants (tenant_id, item_id, name, price, option_values, barcode) values ($1,$2,$3,87500,$4,$5) returning id`,
        [tid, item, `${col} / ${age} / ${sty}`, [col, age, sty], '29900000000' + String(i).padStart(2, '0')])).id;
      await c.query(`select stock_move($1,$2,$3,$4,$5,'opening',null,null,null,$6,'test')`, [tid, store, item, v, q * 1000, emp]);
    }
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
    const piecesNow = async () => Number((await one(`select coalesce(sum(l.qty), 0) as q from stock_levels l join item_variants v on v.id = l.variant_id and v.deleted_at is null where l.tenant_id = $1`, [tid])).q);

    // R1 a split before the tidy is refused: Style has stripe and Stripes
    let r = await tool('split', { product: item, by: 'Style' });
    check('R1 split refuses an option with several spellings of one thing', r.isError === true && /Tidy it first/.test(words(r)), words(r));

    // R2 tidy alone shows the groups and the merge
    r = await tool('tidy', { product: item, option: 'Style' });
    check('R2 tidy proposes Stripe, Plain, Design, and names the merge and the label to reprint', /Stripe/.test(words(r)) && /merges into/.test(r.structuredContent.html) && /reprint/.test(r.structuredContent.html), words(r));
    await tool('cancel', { proposal: (/data-confirm="([0-9a-f-]{36})"/.exec(r.structuredContent.html) || [])[1] });

    // R3 tidy the stock: one plan
    const before = await piecesNow();
    r = await tool('plan', {
      steps: [
        { tool: 'edit_category', args: { verb: 'new', name: 'Long Sleeve', under: 'Shirt' } },
        { tool: 'tidy', args: { product: item, option: 'Colour' } },
        { tool: 'tidy', args: { product: item, option: 'Style' } },
        { tool: 'rename_option', args: { product: item, option: 'Age', to: 'Size' } },
        { tool: 'split', args: { product: item, by: 'Style', names: { Stripe: 'Long Sleeve Stripe', Plain: 'Long Sleeve Plain', Design: 'Long Sleeve Design' }, category: 'Shirt › Long Sleeve' } },
      ],
      asked: 'tidy the stock',
    });
    const html = (r.structuredContent || {}).html || '';
    check('R3 the plan comes back as one card, checked, with the shop\'s name to type', /All accounted for/.test(html) && /data-type-name="Reshape Shop"/.test(html) && /Long Sleeve Design/.test(html), words(r));
    check('R3 nothing changed yet', (await one(`select count(*)::int as n from items where tenant_id = $1 and deleted_at is null`, [tid])).n === 1);
    let k = await press(r);
    const after = await all(`select i.name, k.name as cat, p.name as parent, i.option_names, (select count(*)::int from item_variants v where v.item_id = i.id and v.deleted_at is null) as n
                               from items i join categories k on k.id = i.category_id left join categories p on p.id = k.parent_id where i.tenant_id = $1 and i.deleted_at is null order by i.name`, [tid]);
    check('R3 three products in Shirt › Long Sleeve, each with Colour and Size', after.length === 3 && after.every((x) => x.cat === 'Long Sleeve' && x.parent === 'Shirt' && x.option_names.join() === 'Colour,Size'),
      JSON.stringify(after) + ' ' + words(k));
    check('R3 lines: Stripe 3 (one merged), Plain 2, Design 2', after.map((x) => `${x.name}:${x.n}`).join() === 'Long Sleeve Design:2,Long Sleeve Plain:2,Long Sleeve Stripe:3', after.map((x) => `${x.name}:${x.n}`).join());
    check('R3 the pieces are the same before and after', (await piecesNow()) === before, `${before} -> ${await piecesNow()}`);
    const vals = (await all(`select v.option_values from item_variants v where v.tenant_id = $1 and v.deleted_at is null`, [tid])).map((x) => x.option_values[0]);
    check('R3 one spelling for each colour', [...new Set(vals)].sort().join() === 'Red,White', [...new Set(vals)].join());
    const barcodes = (await all(`select barcode from item_variants where tenant_id = $1 and deleted_at is null`, [tid])).length;
    check('R3 every line kept its barcode but the merged one', barcodes === 7, barcodes);

    // R4 Restore puts the lines back in Chemise Long Sleeve
    const log = (await one(`select id from assistant_log where tenant_id = $1 and kind = 'plan'`, [tid])).id;
    r = await tool('restore', { change: log });
    k = await press(r);
    const back = await one(`select i.name, (select count(*)::int from item_variants v where v.item_id = i.id and v.deleted_at is null) as n from items i where i.id = $1 and i.deleted_at is null`, [item]);
    const left = (await one(`select count(*)::int as n from items where tenant_id = $1 and deleted_at is null and id <> $2`, [tid, item])).n;
    check('R4 Restore brings the lines back into the one product, and the split ones go', back && back.n === 7 && left === 0, JSON.stringify(back) + ' left ' + left + ' ' + words(k));

    // R5 an import of a file's rows: a new product, a line of the old one spelled as it is spelled
    r = await tool('import', {
      rows: [
        { n: 2, name: 'Polo Kids', category: 'Shirt', sub_category: 'Short Sleeve', price: 450, stock: 4, options: { Colour: 'navy', Size: '6' } },
        { n: 3, name: 'Polo Kids', category: 'Shirt', sub_category: 'Short Sleeve', price: 450, stock: 2, options: { Colour: 'navy', Size: '7' } },
        { n: 4, name: 'Chemise  Long Sleeve', price: 875, stock: 3, options: { Colour: 'red', Size: '9', Style: 'designed' } },
      ],
    });
    const ih = (r.structuredContent || {}).html || '';
    check('R5 the import card says what goes in, and reads designed as the shop\'s Design', /1 new/.test(words(r)) && /designed → Design/.test(words(r)), words(r));
    k = await press(r);
    const polo = await one(`select i.id, k.name as cat, p.name as parent, (select count(*)::int from item_variants v where v.item_id = i.id) as n,
                                   (select sum(qty)::int from stock_levels l where l.item_id = i.id) as q
                              from items i join categories k on k.id = i.category_id join categories p on p.id = k.parent_id where i.tenant_id = $1 and i.name = 'Polo Kids'`, [tid]);
    check('R5 Polo Kids is in Shirt › Short Sleeve with 2 lines and 6 pieces', polo && polo.cat === 'Short Sleeve' && polo.parent === 'Shirt' && polo.n === 2 && polo.q === 6000, JSON.stringify(polo) + ' ' + words(k));
    const red9 = await one(`select option_values from item_variants where item_id = $1 and option_values[2] = '9'`, [item]);
    check('R5 the old product\'s new line is Red / 9 / Design', red9 && red9.option_values.join('/') === 'Red/9/Design', JSON.stringify(red9) + ' ' + ih.slice(0, 80));

    // R6 a row for a line that already holds stock: asked once, then added
    r = await tool('import', { rows: [{ n: 2, name: 'Polo Kids', price: 450, stock: 3, options: { Colour: 'Navy', Size: '6' } }] });
    check('R6 a line already in stock is asked about: add or replace', /already hold stock/.test(words(r)) && !r.structuredContent, words(r));
    r = await tool('import', { rows: [{ n: 2, name: 'Polo Kids', price: 450, stock: 3, options: { Colour: 'Navy', Size: '6' } }], existing: 'add' });
    await press(r);
    const navy6 = await one(`select l.qty from stock_levels l join item_variants v on v.id = l.variant_id where v.item_id = $1 and v.option_values[2] = '6'`, [polo.id]);
    check('R6 with add, 4 + 3 = 7', navy6 && navy6.qty === 7000, JSON.stringify(navy6));

    // R7 move: Polo Kids' lines into a product with the same options
    const tee = (await one(`insert into items (tenant_id, name, price, track_stock, option_names) values ($1, 'Tee', 30000, true, '{Colour,Size}') returning id`, [tid])).id;
    r = await tool('move', { product: polo.id, into: tee });
    await press(r);
    const moved = await one(`select (select count(*)::int from item_variants where item_id = $1 and deleted_at is null) as n, (select deleted_at is not null from items where id = $2) as gone`, [tee, polo.id]);
    check('R7 the lines move to Tee and the emptied Polo Kids goes', moved.n === 2 && moved.gone === true, JSON.stringify(moved));
    const hist = await one(`select count(*)::int as n from stock_movements where tenant_id = $1 and item_id = $2`, [tid, tee]);
    check('R7 their history went with them', hist.n >= 3, hist.n);

    // R8 rename an option on its own
    r = await tool('rename_option', { product: tee, option: 'Size', to: 'age' });
    await press(r);
    check('R8 Size is now Age', (await one(`select option_names from items where id = $1`, [tee])).option_names.join() === 'Colour,Age');

    // R9 a product counted by size alone, its colours said later (the owner, 2026-10-29: "3 is blue 7 is red"):
    // Colour is added (every size Mixed), and a size's pieces go to a line of each colour
    const sizes = (await one(`insert into items (tenant_id, name, price, track_stock, option_names) values ($1, 'Long Sleeve Plain', 87500, true, '{Size}') returning id`, [tid])).id;
    for (const [s, q] of [['10', 10], ['12', 4], ['13', 2]]) {
      const v = (await one(`insert into item_variants (tenant_id, item_id, name, price, option_values) values ($1,$2,$3,87500,$4) returning id`, [tid, sizes, s, [s]])).id;
      await c.query(`select stock_move($1,$2,$3,$4,$5,'opening',null,null,null,$6,'test')`, [tid, store, sizes, v, q * 1000, emp]);
    }
    const linesOf = async () => (await all(
      `select v.option_values, v.barcode, coalesce((select sum(qty) from stock_levels l where l.variant_id = v.id and l.deleted_at is null), 0)::int / 1000 as q
         from item_variants v where v.item_id = $1 and v.deleted_at is null order by v.option_values::text`, [sizes],
    )).map((x) => `${x.option_values.join('/')}:${x.q}${x.barcode ? '#' + x.barcode : ''}`).join(' ');
    const optionsOf = async () => (await one(`select option_names from items where id = $1`, [sizes])).option_names.join();
    r = await tool('split_colours', { product: sizes, option: 'Colour', lines: [{ where: { Size: '10' }, into: [{ value: 'blue', qty: 3, barcode: '2990000000999' }, { value: 'Red', qty: 7 }] }], asked: 'size 10: 3 blue, 7 red' });
    const sh = (r.structuredContent || {}).html || '';
    check('R9 the card adds Colour, the other sizes Mixed, and splits 10 into Blue 3 and Red 7', !r.isError && /Mixed/.test(sh) && /Blue/.test(sh) && /Red/.test(sh), words(r));
    check('R9 nothing changed yet', (await optionsOf()) === 'Size' && (await linesOf()) === '10:10 12:4 13:2', await linesOf());
    k = await press(r);
    check('R9 Size and Colour: 10 is Blue 3 with its old barcode and Red 7, 10 / Mixed gone, the other sizes Mixed', (await optionsOf()) === 'Size,Colour'
      && (await linesOf()) === '10/Blue:3#2990000000999 10/Red:7 12/Mixed:4 13/Mixed:2', (await linesOf()) + ' ' + words(k));
    const notes = (await all(`select note from stock_movements where tenant_id = $1 and item_id = $2 and reason = 'adjust'`, [tid, sizes])).map((x) => x.note);
    check('R9 the pieces moved as pairs of stock moves', notes.length === 4 && notes.filter((n) => /^Split from/.test(n)).length === 2, notes.join(' | '));
    r = await tool('split_colours', { product: sizes, option: 'Colour', lines: [{ where: { Size: '12' }, into: [{ value: 'Blue', qty: 5 }] }] });
    check('R9 more pieces than the size holds is refused, saying how many it holds', r.isError === true && /holds 4/.test(words(r)), words(r));
    r = await tool('split_colours', { product: sizes, option: 'Colour', lines: [{ where: { Size: '12' }, into: [{ value: 'BLUE', qty: 3 }] }] });
    const sh2 = (r.structuredContent || {}).html || '';
    check('R9 fewer: the card says 1 stays in 12 / Mixed, and BLUE is the shop\'s Blue', /1 stays in 12 \/ Mixed/.test(sh2) && !/New colour/.test(sh2), words(r));
    await press(r);
    check('R9 12 is Blue 3 and Mixed 1', (await linesOf()).includes('12/Blue:3') && (await linesOf()).includes('12/Mixed:1'), await linesOf());

    // R10 Restore, last first: the pieces go back, the lines it made go, and with the last one the option too
    const splits = await all(`select id from assistant_log where tenant_id = $1 and kind = 'split_colours' order by created_at desc`, [tid]);
    await press(await tool('restore', { change: splits[0].id }));
    check('R10 Restore of the second: 12 is Mixed 4 again, Colour stays', (await linesOf()) === '10/Blue:3#2990000000999 10/Red:7 12/Mixed:4 13/Mixed:2' && (await optionsOf()) === 'Size,Colour', await linesOf());
    await press(await tool('restore', { change: splits[1].id }));
    check('R10 Restore of the first: by size alone again, 10 holds 10', (await optionsOf()) === 'Size' && (await linesOf()) === '10:10 12:4 13:2', (await optionsOf()) + ' ' + (await linesOf()));
  } finally {
    await devguard.cleanupTenant(c, tid).catch((e) => console.log('cleanup: ' + e.message));
    await c.query(`delete from assistant_clients where client_id = $1`, [client]).catch(() => {});
    await c.end();
  }
  console.log(failures === 0 ? 'ASSISTANT RESHAPE PASS' : `ASSISTANT RESHAPE FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
