const assert = require("node:assert/strict");
const test = require("node:test");

test("runtime test harness is configured", () => {
  assert.equal(1 + 1, 2);
});
