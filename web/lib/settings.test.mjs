// settings.test.mjs — what the settings say when read (web/lib/settings.ts).
// Usage: node web/lib/settings.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { AUTO_CLOSE_TIME, notOnYet, olderThan, withDefaults } from "./settings.ts";

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

// a setting that needs a newer till (closing the day by itself, loyalty points)
// names the tills on an older build, after what the setting says
check("the tills too old for a setting are named", () => {
  assert.equal(notOnYet([]), "");
  assert.equal(notOnYet(["Till 2"]), " Not on Till 2 until it is updated.");
  assert.equal(notOnYet(["Till 2", "Bar"]), " Not on Till 2, Bar until they are updated.");
  assert.deepEqual(olderThan([{ name: "Till 1", till_version: 36 }, { name: "Till 2", till_version: 32 }, { name: "Bar", till_version: 34 }], 33), ["Till 2"]);
  assert.deepEqual(olderThan([{ name: "Till 1", till_version: 36 }, { name: "Till 2", till_version: 32 }, { name: "Bar", till_version: 34 }], 35), ["Till 2", "Bar"]);
});

console.log(failures === 0 ? "ALL PASS" : failures + " FAILED");
process.exitCode = failures === 0 ? 0 : 1;
