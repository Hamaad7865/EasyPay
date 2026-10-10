// guest.test.mjs — the address on a table's card and the code that carries it
// (web/lib/guest.ts). The path is read back into squares and looked at for
// what every QR code has: its size, and the three finder patterns in their
// corners with the light band round each. Whether a phone reads the address
// out of it was checked once with a decoder that is not part of this project
// (jsQR, 2026-10-10: the address came back letter for letter).
// Usage: node web/lib/guest.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { cardAddress, qrSquares, ORDER_SITE } from "./guest.ts";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("ok   " + name);
  } catch (e) {
    failures++;
    console.log("FAIL " + name + "\n     " + e.message);
  }
}

const STORE = "2peljhf2x5vityqa";
const TABLE = "5f0c2a9e-0007-4a11-8c01-000000000007";

// the path back into rows of squares, as the page draws them
function squares({ side, path }) {
  const grid = Array.from({ length: side }, () => Array(side).fill(false));
  const stroke = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
  let m, used = 0;
  while ((m = stroke.exec(path))) {
    const [all, c, r, run, back] = m;
    assert.equal(run, back);
    for (let i = 0; i < Number(run); i++) grid[Number(r)][Number(c) + i] = true;
    used += all.length;
  }
  assert.equal(used, path.length, "the path is made of those strokes and nothing else");
  return grid;
}

check("a card's address is the ordering site, the store's public id and the table's id", () => {
  assert.equal(cardAddress(STORE, TABLE), `https://order.easypaypos.com/${STORE}/${TABLE}`);
  assert.ok(cardAddress(STORE, TABLE).startsWith(ORDER_SITE + "/"));
});

check("what is not a store's public id or a table's id makes no address", () => {
  assert.throws(() => cardAddress("", TABLE));
  assert.throws(() => cardAddress(STORE.toUpperCase(), TABLE));
  assert.throws(() => cardAddress(STORE.slice(1), TABLE));
  assert.throws(() => cardAddress(STORE, TABLE.slice(0, 8)));
  assert.throws(() => cardAddress(STORE, "../" + TABLE));
  assert.throws(() => cardAddress(TABLE, STORE));
});

check("a card's code is a QR code of a size a phone reads from a table", () => {
  const code = qrSquares(cardAddress(STORE, TABLE));
  assert.equal((code.side - 17) % 4, 0, "a QR code's side is 17 and four for each version");
  assert.ok(code.side >= 33 && code.side <= 45, "side " + code.side);
  assert.ok(code.path.length < 6000, "a short path: " + code.path.length);
});

check("it has the three finder patterns in their corners, each with its light band", () => {
  const code = qrSquares(cardAddress(STORE, TABLE));
  const g = squares(code), n = code.side;
  const finder = (r0, c0) => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const eye = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      assert.equal(g[r0 + r][c0 + c], ring || eye, `finder at ${r0},${c0}: square ${r},${c}`);
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 0; i < 8; i++) {
    assert.equal(g[7][i], false); assert.equal(g[i][7], false);
    assert.equal(g[7][n - 1 - i], false); assert.equal(g[i][n - 8], false);
    assert.equal(g[n - 8][i], false); assert.equal(g[n - 1 - i][7], false);
  }
  assert.equal(g[n - 8][8], true, "and the square every code has dark, by the lower finder");
});

check("the same address gives the same code, and another table another", () => {
  const a = qrSquares(cardAddress(STORE, TABLE));
  const b = qrSquares(cardAddress(STORE, TABLE));
  const other = qrSquares(cardAddress(STORE, TABLE.replace(/7$/, "8")));
  assert.deepEqual(a, b);
  assert.notEqual(a.path, other.path);
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
