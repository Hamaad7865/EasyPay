// page.test.cjs — what page.cjs's text() makes of a page's markup. Every
// "the page says ..." check in the page suites (pos-pages, shop-pages,
// unapproved-kept) reads a page through it, so what it gets wrong, they read
// wrong. Markup in, words out: no database and no sign-in.
// Usage: node db/tests/page.test.cjs
const { text, rowsOf } = require('./page.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const reads = (name, html, want) => { const got = text(html); check(name, got === want, got === want ? undefined : `read ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };

// the markup is as React writes it: & " ' < > in what a page says become &amp; &quot; &#x27; &lt; &gt;
reads('T1 the tags go and the words between them stay apart', '<h1>Sales</h1><p>Rs <b>522.00</b><!-- --> collected</p>', 'Sales Rs 522.00 collected');
reads('T2 an ampersand, an apostrophe and a quote in a name are read back', '<td>Fish &amp; Chips</td><td>Asha&#x27;s &quot;special&quot;</td>', 'Fish & Chips Asha\'s "special"');
reads('T3 a name that itself says &quot; is not unescaped twice', '<td>&amp;quot;</td>', '&quot;');
reads('T3 nor one that says &#x27; or &amp;', '<td>&amp;#x27; &amp;amp;</td>', '&#x27; &amp;');
reads('T4 a style or script block goes with what is in it', '<style>.a{color:red}</style><p>ok</p><script>let a = 1;</script>', 'ok');
reads('T4 one written over several lines too', '<style>\n.a {\n  color: red;\n}\n</style><p>ok</p>', 'ok');
reads('T5 a block that only comes together once another is taken out goes too', '<scr<script>x</script>ipt>alert(1)</script>ok', 'ok');
reads('T5 as deep as they are folded', '<st<st<style>a</style>yle>b</style>yle>c</style>ok', 'ok');
// &lt; and &gt; are left as written: turning them back would put a tag into what was just cleared of tags
reads('T6 a tag the page only spells out is not made into one', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', '&lt;script&gt;alert(1)&lt;/script&gt;');
{
  const rows = rowsOf('<table><tr><th>Item</th><th>Sold</th></tr><tr><td>Fish &amp; Chips</td><td>2</td></tr></table>');
  check('T7 a table is read row by row through the same reading', rows.length === 2 && rows[0] === 'Item | Sold' && rows[1] === 'Fish & Chips | 2', JSON.stringify(rows));
}

console.log(failures === 0 ? 'PAGE PASS' : `PAGE FAIL (${failures})`);
process.exit(failures ? 1 : 0);
