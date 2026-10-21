// settings.test.mjs — what the settings say when read (web/lib/settings.ts).
// Usage: node web/lib/settings.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { AUTO_CLOSE_TIME, withDefaults } from "./settings.ts";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); } catch (e) { failures += 1; console.log("FAIL " + name + " " + e.message); }
}

check("the day closes by itself at a time, or not at all", () => {
  assert.equal(withDefaults({}).autoClose, null);
  assert.equal(withDefaults({ autoClose: "05:00" }).autoClose, "05:00");
  assert.equal(withDefaults({ autoClose: null }).autoClose, null);
  for (const bad of ["24:00", "5:00", "00:60", 5, "midnight"]) assert.equal(withDefaults({ autoClose: bad }).autoClose, null, String(bad));
  assert.ok(AUTO_CLOSE_TIME.test("23:59") && !AUTO_CLOSE_TIME.test("23:5"));
});

console.log(failures === 0 ? "ALL PASS" : failures + " FAILED");
process.exitCode = failures === 0 ? 0 : 1;
