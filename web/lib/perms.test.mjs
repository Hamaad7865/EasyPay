// perms.test.mjs — what the Roles page offers and saves (web/lib/perms.ts).
// Usage: node web/lib/perms.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { permGroups, savedPerms } from "./perms.ts";

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
const ids = (mode) => permGroups(mode).flatMap((g) => g.perms.map(([k]) => k));
const STOCK = ["stock.view", "stock.receive", "stock.adjust", "stock.count", "suppliers.edit", "costs.view"];

check("a shop is offered the six stock permissions, in a group of their own", () => {
  const g = permGroups("retail").find((x) => x.title === "Stock");
  assert.deepEqual(g.perms.map(([k]) => k), STOCK);
});
check("a restaurant is not: its stock stays under editing the menu", () => {
  assert.equal(permGroups("restaurant").some((x) => x.title === "Stock"), false);
  assert.equal(STOCK.some((p) => ids("restaurant").includes(p)), false);
  assert.ok(ids("restaurant").includes("items.edit"));
});
check("everything a restaurant is offered, a shop is offered too", () => {
  assert.deepEqual(ids("restaurant").filter((p) => !ids("retail").includes(p)), []);
});
check("no permission is offered twice", () => {
  for (const mode of ["restaurant", "retail"]) assert.equal(new Set(ids(mode)).size, ids(mode).length, mode);
});

check("saving a role keeps what the page does not show", () => {
  // a restaurant's role was given the stock permissions by the migration: its page does not list them, and must not drop them
  const had = ["sale.create", "items.edit", "stock.view", "costs.view", "something.newer"];
  assert.deepEqual(savedPerms("restaurant", had, ["sale.create"]).sort(), ["costs.view", "sale.create", "something.newer", "stock.view"]);
});
check("for a shop the ticks decide the stock permissions", () => {
  const had = ["sale.create", "items.edit", "stock.view", "costs.view", "something.newer"];
  assert.deepEqual(savedPerms("retail", had, ["sale.create", "stock.adjust"]).sort(), ["sale.create", "something.newer", "stock.adjust"]);
});
check("a tick for something the page never offered is not saved", () => {
  assert.deepEqual(savedPerms("retail", [], ["sale.create", "*", "made.up"]), ["sale.create"]);
  assert.deepEqual(savedPerms("restaurant", [], ["stock.view", "sale.create"]), ["sale.create"]);
});
check("a permission is saved once", () => {
  assert.deepEqual(savedPerms("retail", ["sale.create"], ["sale.create", "sale.create"]), ["sale.create"]);
});

process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} FAILED` : "all passed");
