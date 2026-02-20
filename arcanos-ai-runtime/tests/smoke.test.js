import assert from "node:assert/strict";
import test from "node:test";

test("runtime test harness is configured", () => {
  assert.equal(1 + 1, 2);
});
