import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeBudget, hasSufficientBudget, assertBudgetAvailable } from "../src/runtime/runtimeBudget.js";
import { RuntimeBudgetExceededError } from "../src/runtime/runtimeErrors.js";

test("Runtime Budget Logic", async (t) => {
  await t.test("should create a budget with default values", () => {
    const budget = createRuntimeBudget();
    assert.ok(budget.startedAt <= Date.now());
    assert.strictEqual(budget.watchdogLimit, 45000);
    assert.strictEqual(budget.safetyBuffer, 2000);
    assert.ok(budget.hardDeadline > budget.startedAt);
  });

  await t.test("should report sufficient budget", () => {
    const budget = createRuntimeBudget();
    assert.ok(hasSufficientBudget(budget, 10000));
    assert.ok(!hasSufficientBudget(budget, 44000));
  });

  await t.test("assertBudgetAvailable should throw on exhausted budget", () => {
    const budget = {
      startedAt: Date.now() - 50000,
      hardDeadline: Date.now() - 5000,
      watchdogLimit: 45000,
      safetyBuffer: 2000
    };
    assert.throws(() => assertBudgetAvailable(budget), RuntimeBudgetExceededError);
  });
});
