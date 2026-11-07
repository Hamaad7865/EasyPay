// receipt-popup.test.cjs — the Receipts page after Carfectionist's tickets
// (docs/superpowers/specs/2026-11-07-receipts-popup-design.md), opened as its
// owner would, on a restaurant whose till made the sales (through sync_push).
// It says that the days' figures are the Orders report's, that a receipt's
// pop-up prints the stored total and tax lines that add up to the stored tax,
// that a copy says so and says what was refunded, that a number is found on any
// day, that the ones to check are listed whatever the days and counted as the
// menu's badge counts them, that changing how a receipt was paid and signing
// one off come back to the receipt, that only plain payment types are offered
// and taken, that a client live on MRA is not offered the change, and who may
// see the page.
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/receipt-popup.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');
const { open, code, text, rowsOf, stats } = require('./page.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });
const id = () => crypto.randomUUID();
const rs = (cents) => 'Rs ' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = (cents) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-rp@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'Popup Bistro','Main','RP1','Owner',$2,'premium','restaurant') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, owner = made.employee_id;
    await c.query(`select seed_demo_catalog($1)`, [tid]);
    const push = async (ops) => {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try {
        const out = (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r;
        const bad = out.filter((o) => o.status !== 'applied');
        if (bad.length) throw new Error('the server refused ' + JSON.stringify(bad));
        return out;
      } finally { await c.query('RESET ROLE'); }
    };
    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'Counter','T1') returning id`, [tid, store])).id;
    const pt = async (nm) => (await one(`select id from payment_types where tenant_id = $1 and name = $2`, [tid, nm])).id;
    const cash = await pt('Cash'), card = await pt('Card');
    const account = (await one(`insert into payment_types (tenant_id, name, kind, sort_order) values ($1,'On account','account',9) returning id`, [tid])).id;
    const item = async (nm) => one(`select id, price::int as price from items where tenant_id = $1 and name = $2`, [tid, nm]);
    const cari = await item('Cari poulet'), dholl = await item('Dholl puri'), alouda = await item('Alouda');
    const rice = await one(`select id, price::int as price from modifiers where tenant_id = $1 and name = 'Extra rice'`, [tid]);
    const loyal = (await one(`select id from discounts where tenant_id = $1 and name = 'Loyalty member'`, [tid])).id;
    const ravi = (await one(`insert into customers (tenant_id, name, phone, email) values ($1,'Ravi Doorga','5250 1234','ravi@example.com') returning id`, [tid])).id;
    const at = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
    await push([op('shift.open', { id: id(), device_id: dev, opening_float: 0, opened_at: at(5 * 24 * 60) })]);

    // RP1-1: Ravi's Cari poulet with Extra rice and a Dholl puri, 10% off for a loyal member, VAT inside the prices, paid cash
    const tk1 = id(), r1 = id();
    const sub = cari.price + rice.price + dholl.price;
    const disc = Math.floor((sub * 10 + 50) / 100);
    await push([
      op('ticket.create', { id: tk1, store_id: store }), op('ticket.update_meta', { ticket_id: tk1, customer_id: ravi }),
      op('ticket.add_line', { id: id(), ticket_id: tk1, item_id: cari.id, qty: 1000, modifier_ids: [rice.id] }),
      op('ticket.add_line', { id: id(), ticket_id: tk1, item_id: dholl.id, qty: 1000 }),
      op('receipt.create', { id: r1, ticket_id: tk1, store_id: store, device_id: dev, number: 'RP1-1', device_seq: 1, device_time: at(4),
        discounts: [{ discount_id: loyal }], payments: [{ payment_type_id: cash, amount: sub - disc, tendered: 100000, change: 100000 - (sub - disc) }] }),
    ]);
    const s1 = await one(`select subtotal::int, discount_total::int, tax_total::int, total::int, needs_review from receipts where id = $1`, [r1]);
    check('S1 the sale went in as the till rang it', s1.total === sub - disc && s1.discount_total === disc && !s1.needs_review && s1.tax_total > 0, JSON.stringify(s1));
    // RP1-2: an Alouda by card, refunded whole as RP1-R3
    const tk2 = id(), r2 = id(), r3 = id();
    await push([
      op('ticket.create', { id: tk2, store_id: store }), op('ticket.add_line', { id: id(), ticket_id: tk2, item_id: alouda.id, qty: 1000 }),
      op('receipt.create', { id: r2, ticket_id: tk2, store_id: store, device_id: dev, number: 'RP1-2', device_seq: 2, device_time: at(3), payments: [{ payment_type_id: card, amount: alouda.price }] }),
    ]);
    const rl2 = (await one(`select id from receipt_lines where receipt_id = $1`, [r2])).id;
    await push([op('refund.create', { id: r3, refund_of: r2, store_id: store, device_id: dev, number: 'RP1-R3', device_seq: 3, device_time: at(2),
      reason: 'spilt', lines: [{ receipt_line_id: rl2, qty: 1000 }], payments: [{ payment_type_id: card, amount: alouda.price }] })]);
    // RP1-4, three days ago: paid short, so flagged
    const tk4 = id(), r4 = id();
    await push([
      op('ticket.create', { id: tk4, store_id: store }), op('ticket.add_line', { id: id(), ticket_id: tk4, item_id: dholl.id, qty: 1000 }),
      op('receipt.create', { id: r4, ticket_id: tk4, store_id: store, device_id: dev, number: 'RP1-4', device_seq: 4, device_time: at(3 * 24 * 60), payments: [{ payment_type_id: cash, amount: dholl.price - 100 }] }),
    ]);
    check('S2 the short one is flagged', (await one(`select needs_review from receipts where id = $1`, [r4])).needs_review);

    const ctx = { tenantId: tid, employeeId: owner, mode: 'restaurant' };
    const see = async (who, href, sp) => {
      await c.query('SAVEPOINT pg');
      try {
        const html = await open(c, who, href, sp);
        await c.query('RELEASE SAVEPOINT pg');
        return { html, says: text(html) };
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT pg');
        return { html: '', says: '', error: (e && e.stack) || String(e) };
      }
    };
    // a form's action, as the pop-up sends it: it ends by going back to the page (the stand-in throws "redirect <to>")
    const send = async (fn, fields) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(fields)) f.set(k, v);
      await c.query('SAVEPOINT act');
      try {
        await code(c, ctx, 'app/backoffice/receipts/actions.ts')[fn](f);
        await c.query('RELEASE SAVEPOINT act');
        return 'no redirect';
      } catch (e) {
        const m = (e && e.message) || String(e);
        // a refusal goes back too; what it tried is undone, as the back office's own transaction would be
        if (m.startsWith('redirect ')) { await c.query(m.includes('err=') ? 'ROLLBACK TO SAVEPOINT act' : 'RELEASE SAVEPOINT act'); return decodeURIComponent(m.slice(9)); }
        await c.query('ROLLBACK TO SAVEPOINT act');
        return 'error ' + m;
      }
    };
    const days = await one(`select ((now() - interval '4 minutes') at time zone s.timezone)::date::text as from, (now() at time zone s.timezone)::date::text as to from stores s where s.id = $1`, [store]);
    const sp = { from: days.from, to: days.to };

    let p = await see(ctx, '/backoffice/receipts', sp);
    check('L1 the page opens for the owner', !p.error && p.says.includes('Receipts'), p.error);
    const rows = rowsOf(p.html);
    const row = (n) => rows.find((r) => r.startsWith(n + ' ') || r.startsWith(n + ' |')) || '';
    check('L2 the days\' receipts are listed', ['RP1-1', 'RP1-2', 'RP1-R3'].every((n) => row(n)), rows.join('\n'));
    check('L2 one from three days ago is not', !row('RP1-4'));
    check('L3 a line says the order, the till, who, how it was paid and the total', /Ravi Doorga.*Counter.*Owner.*Cash/.test(row('RP1-1')) && row('RP1-1').includes(rs(sub - disc)), row('RP1-1'));
    check('L3 a refund is marked and counts against', row('RP1-R3').includes('Refund') && row('RP1-R3').includes('-' + rs(alouda.price)), row('RP1-R3'));
    const sum = (p.says.match(/(\d+) receipts · (Rs [\d,.-]+) without tax · (-?Rs [\d,.]+) in all/) || []);
    check('L4 the count and the figures of the days', sum[1] === '3' && sum[3] === rs(sub - disc), sum[0]);
    const orders = await see(ctx, '/backoffice/reports/orders', sp);
    const total = (stats(orders.html).find((x) => x.startsWith('Total:')) || '').replace('Total: ', '');
    check('L4 the same total as the Orders report for those days', total === sum[3], total + ' vs ' + sum[3]);
    check('L5 the receipt to check, from another day, is said at the top', p.says.includes('1 receipt needs a look'), (p.says.match(/\d+ receipts? needs? a look/) || [])[0]);

    // the pop-up
    p = await see(ctx, '/backoffice/receipts', { ...sp, r: r1 });
    check('P1 a receipt opens in its pop-up', !p.error && p.html.includes('class="rc-pop"') && p.says.includes('Receipt RP1-1'), p.error);
    const paper = [...p.html.matchAll(/<div class="pp-line[^"]*"[^>]*>(.*?)<\/div>/g)].map((m) => text(m[1]));
    const says = paper.join('\n');
    check('P2 the paper says COPY', paper.includes('COPY'), says);
    check('P2 it carries the add-on and the discount', says.includes('Extra rice') && says.includes('Discount: Loyalty member'), says);
    const totalLine = paper.find((l) => l.startsWith('TOTAL')) || '';
    check('P3 its total is the stored total', totalLine.endsWith(rs(s1.total)), totalLine + ' vs ' + rs(s1.total));
    const taxes = paper.filter((l) => /^VAT \d+%/.test(l)).map((l) => Math.round(Number(l.split(/\s+/).pop().replace(/,/g, '')) * 100));
    check('P3 its tax lines add up to the stored tax', taxes.length > 0 && taxes.reduce((a, b) => a + b, 0) === s1.tax_total, JSON.stringify(taxes) + ' vs ' + s1.tax_total);
    check('P3 and what was given and handed back', says.includes('Given') && says.includes(plain(100000)) && says.includes('Change'), says);
    check('P4 WhatsApp goes to the customer\'s number, with the country', p.html.includes('href="https://wa.me/23052501234?text='));
    check('P4 Email is addressed to the customer', p.html.includes('href="mailto:ravi@example.com?subject=Receipt%20RP1-1'));
    const sent = decodeURIComponent((p.html.match(/href="https:\/\/wa\.me\/\d+\?text=([^"]*)"/) || [])[1] || '').replace(/&amp;/g, '&');
    check('P4 the text sent is a 58 mm paper\'s, which a phone shows without wrapping', sent.includes('RP1-1') && sent.includes('Cari poulet') && sent.split('\n').every((l) => l.length <= 32), sent);
    check('P4 their history is a click away', p.html.includes(`href="/backoffice/customers/${ravi}"`));
    check('P5 the change is offered on the cash payment, to plain types only', p.html.includes('Change payment method') && p.html.includes(`value="${card}"`) && !p.html.includes(`value="${account}"`));

    p = await see(ctx, '/backoffice/receipts', { ...sp, r: r2 });
    const paper2 = [...p.html.matchAll(/<div class="pp-line[^"]*"[^>]*>(.*?)<\/div>/g)].map((m) => text(m[1]));
    check('P6 a sale refunded since says so on its copy', paper2.includes('*** REFUNDED ***'), paper2.join(' / '));
    p = await see(ctx, '/backoffice/receipts', { ...sp, r: r3 });
    check('P7 a refund names the sale and links to it', p.says.includes('Refund RP1-R3') && p.says.includes('Refund of') && p.html.includes(`r=${r2}`), p.error);

    // finding a number, on any day
    p = await see(ctx, '/backoffice/receipts', { q: 'RP1-4' });
    check('F1 a number found on another day opens', !p.error && p.html.includes('class="rc-pop"') && p.says.includes('Receipt RP1-4'), p.error);
    p = await see(ctx, '/backoffice/receipts', { q: 'RP1' });
    check('F2 a number several have lists them all and opens none', rowsOf(p.html).filter((r) => r.startsWith('RP1-')).length === 4 && !p.html.includes('class="rc-pop"'), rowsOf(p.html).join(' / '));
    p = await see(ctx, '/backoffice/receipts', { q: '100%' });
    check('F3 what is typed is looked for as it is', !p.error && p.says.includes('No receipt has that number'), p.error);

    // the ones to check
    p = await see(ctx, '/backoffice/receipts', { view: 'check' });
    const checkRows = rowsOf(p.html).filter((r) => r.startsWith('RP1-'));
    check('C1 To check lists the flagged one whatever the days', checkRows.length === 1 && checkRows[0].startsWith('RP1-4'), checkRows.join(' / '));
    const badge = await (await code(c, ctx, 'app/backoffice/counts/route.ts').GET()).json();
    check('C2 as many as the menu\'s badge says', (badge.counts['/backoffice/receipts'] || {}).n === 1, JSON.stringify(badge.counts['/backoffice/receipts']));
    let back = `/backoffice/receipts?view=check&r=${r4}`;
    let went = await send('resolveReceipt', { receipt: r4, note: 'Customer paid the rest', back });
    check('C3 signing off comes back to the receipt', went.startsWith(back + '&ok=Signed off'), went);
    p = await see(ctx, '/backoffice/receipts', { view: 'check' });
    check('C3 and it is not to check any more', p.says.includes('Nothing to check'), rowsOf(p.html).join(' / '));

    // changing how it was paid
    back = `/backoffice/receipts?from=${sp.from}&to=${sp.to}&r=${r1}`;
    went = await send('correctPayment', { receipt: r1, from: cash, to: account, back });
    check('M1 a payment is not moved to On account', went.startsWith(back + '&err=Only cash, card'), went);
    went = await send('correctPayment', { receipt: r1, from: cash, to: card, back });
    check('M2 a change of method comes back to the receipt', went.startsWith(back + '&ok=Payment method changed'), went);
    check('M2 the correction is kept', (await one(`select count(*)::int n from payment_corrections where receipt_id = $1 and new_payment_type_id = $2`, [r1, card])).n === 1);
    p = await see(ctx, '/backoffice/receipts', { ...sp, r: r1 });
    check('M3 the pop-up says it was changed, and the paper prints the new one', p.says.includes('changed from Cash') && [...p.html.matchAll(/<div class="pp-line[^"]*"[^>]*>(.*?)<\/div>/g)].some((m) => text(m[1]).startsWith('Card ')), p.error);
    check('M3 the list marks it corrected', row('RP1-1') !== '' && rowsOf(p.html).find((r) => r.startsWith('RP1-1 '))?.includes('corrected'), rowsOf(p.html).find((r) => r.startsWith('RP1-1 ')));

    // a client live on MRA keeps how a sale was paid
    await c.query('SAVEPOINT mra');
    let live = true;
    try { await c.query(`update tenants set mra = 'live' where id = $1`, [tid]); await c.query('RELEASE SAVEPOINT mra'); }
    catch (e) { live = false; await c.query('ROLLBACK TO SAVEPOINT mra'); console.log('SKIP MRA: ' + e.message); }
    if (live) {
      p = await see(ctx, '/backoffice/receipts', { ...sp, r: r2 });
      check('R1 live on MRA, the change is not offered, and why', p.says.includes('Live on MRA e-invoicing') && !p.html.includes('Change payment method'), p.error);
      // the server's own refusal is the word the action turns into a sentence (this suite's stand-in for the
      // tenant's transaction cannot carry on after a failed statement, so the server is asked directly)
      await c.query('SAVEPOINT mra2');
      let said = '';
      try {
        await c.query('SET LOCAL ROLE app_user');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
        await c.query(`select push_payment_correct($1, $2, $3::jsonb)`, [tid, owner, JSON.stringify({ id: id(), receipt_id: r2, from_payment_type_id: card, to_payment_type_id: cash })]);
      } catch (e) { said = e.message; }
      await c.query('ROLLBACK TO SAVEPOINT mra2');
      await c.query('RESET ROLE');
      check('R2 the server refuses with the word the action says in words', said === 'mra-no-correction', said);
      await c.query(`update tenants set mra = 'off' where id = $1`, [tid]);
    }

    // who may see it
    const role = async (nm, perms) => (await one(`insert into roles (tenant_id, name, permissions) values ($1,$2,$3::jsonb) returning id`, [tid, nm, JSON.stringify(perms)])).id;
    const person = async (nm, r) => (await one(`insert into employees (tenant_id, name, role_id) values ($1,$2,$3) returning id`, [tid, nm, r])).id;
    const host = await person('Hana', await role('Host', ['backoffice.access']));
    p = await see({ tenantId: tid, employeeId: host, mode: 'restaurant', role: 'Host' }, '/backoffice/receipts', sp);
    check('W1 a role that sees no reports and changes no receipt does not see them', !p.error && p.says.includes('does not include seeing receipts') && !p.says.includes('RP1-1'), p.error);
    const fixer = await person('Fiona', await role('Fixer', ['backoffice.access', 'payment.correct']));
    p = await see({ tenantId: tid, employeeId: fixer, mode: 'restaurant', role: 'Fixer' }, '/backoffice/receipts', { ...sp, r: r2 });
    check('W2 one who corrects payments sees them, and the change', !p.error && p.says.includes('RP1-1') && p.html.includes('Change payment method'), p.error);
    check('W2 but not the sign-off, without the right to refund', !p.html.includes('name="note"'));

    // a shop's page has no table things
    p = await see({ ...ctx, mode: 'retail' }, '/backoffice/receipts', sp);
    check('S3 a shop\'s list calls the column Sale', !p.error && /<th>Sale<\/th>/.test(p.html) && !/<th>Order<\/th>/.test(p.html), p.error);
  } catch (e) {
    failures++;
    console.log('FAIL the suite stopped: ' + ((e && e.stack) || e));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
