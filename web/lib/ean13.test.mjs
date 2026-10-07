// ean13.test.mjs — the bars a label prints (web/lib/ean13.ts).
// A symbol is checked by reading it back: the test decodes the modules with
// tables of its own, built from the one published L table (R is L inverted, G
// is R mirrored), and must get the same thirteen digits out.
// Usage: node web/lib/ean13.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { asEan13, ean13Bars, ean13CheckDigit, ean13HumanGroups, ean13Modules, EAN13_MODULES, isValidEan13 } from "./ean13.ts";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failures += 1;
    console.log("FAIL " + name + " " + e.message);
  }
}

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const R = L.map((c) => [...c].map((b) => (b === "1" ? "0" : "1")).join(""));
const G = R.map((c) => [...c].reverse().join(""));
const FIRST = { LLLLLL: 0, LLGLGG: 1, LLGGLG: 2, LLGGGL: 3, LGLLGG: 4, LGGLLG: 5, LGGGLL: 6, LGLGLG: 7, LGLGGL: 8, LGGLGL: 9 };
// reads a 95-module symbol back into its thirteen digits
function read(modules) {
  assert.equal(modules.length, 95);
  assert.equal(modules.slice(0, 3), "101");
  assert.equal(modules.slice(45, 50), "01010");
  assert.equal(modules.slice(92), "101");
  let parity = "", digits = "";
  for (let i = 0; i < 6; i += 1) {
    const chunk = modules.slice(3 + i * 7, 10 + i * 7);
    const l = L.indexOf(chunk), g = G.indexOf(chunk);
    assert.ok(l >= 0 || g >= 0, "left digit " + i + " is no known pattern");
    parity += l >= 0 ? "L" : "G";
    digits += l >= 0 ? l : g;
  }
  for (let i = 0; i < 6; i += 1) {
    const r = R.indexOf(modules.slice(50 + i * 7, 57 + i * 7));
    assert.ok(r >= 0, "right digit " + i + " is no known pattern");
    digits += r;
  }
  assert.ok(parity in FIRST, "parity " + parity + " stands for no digit");
  return FIRST[parity] + digits;
}

check("the check digit is the published one", () => {
  assert.equal(ean13CheckDigit("400638133393"), 1);
  assert.equal(ean13CheckDigit("590123412345"), 7);
  assert.equal(ean13CheckDigit("200000000001"), 5); // what the database's ean13('200', 1) ends in
});
check("a code is valid only with its own check digit", () => {
  assert.ok(isValidEan13("4006381333931"));
  assert.ok(!isValidEan13("4006381333932"));
  assert.ok(!isValidEan13("400638133393"));
  assert.ok(!isValidEan13("40063813339a1"));
});
check("a symbol reads back as the digits it was made from", () => {
  for (const code of ["4006381333931", "5901234123457", "2000000000015", "2000000000022", "0012345678905", "9780201379624", "8711253001202"]) {
    assert.equal(read(ean13Modules(code)), code);
  }
});
check("every first digit, which only the parity carries, reads back", () => {
  for (let d = 0; d < 10; d += 1) {
    const payload = d + "12345678901";
    const code = payload + ean13CheckDigit(payload);
    assert.equal(read(ean13Modules(code)), code);
  }
});
check("the bars cover exactly the dark modules", () => {
  const code = "5901234123457";
  const modules = ean13Modules(code);
  const drawn = Array(EAN13_MODULES).fill("0");
  for (const b of ean13Bars(code)) for (let x = b.x; x < b.x + b.width; x += 1) drawn[x] = "1";
  assert.equal(drawn.join(""), modules);
  assert.ok(ean13Bars(code).every((b) => b.width >= 1 && b.width <= 4));
});
check("a code that is not valid is not drawn", () => {
  assert.throws(() => ean13Modules("4006381333932"));
});
check("a UPC-A is drawn with a zero in front, and anything else is not drawn", () => {
  assert.equal(asEan13("4006381333931"), "4006381333931");
  assert.equal(asEan13("012345678905"), "0012345678905");
  assert.equal(asEan13(" 4006381333931 "), "4006381333931");
  assert.equal(asEan13("12345670"), null);
  assert.equal(asEan13("ABC-123"), null);
  assert.equal(asEan13(null), null);
});
check("the digits under the bars are one, six and six", () => {
  assert.deepEqual(ean13HumanGroups("5901234123457"), ["5", "901234", "123457"]);
});

console.log(failures === 0 ? "EAN13 PASS" : `EAN13 FAIL (${failures})`);
// the exit code is set and node is left to end by itself: process.exit() here has crashed node on Windows while it was closing down, after every check had passed
process.exitCode = failures ? 1 : 0;
