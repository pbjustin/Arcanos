import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveRuntimeWorkerStartupConfig
} from "../dist/config/env.js";
import {
  waitForRuntimeWorkerStartup
} from "../dist/lifecycle/startup.js";

describe("standalone AI runtime worker startup lifecycle", () => {
  it("validates the bounded Redis readiness deadline", () => {
    assert.deepEqual(
      resolveRuntimeWorkerStartupConfig({}),
      { timeoutMs: 30000 }
    );
    assert.deepEqual(
      resolveRuntimeWorkerStartupConfig({
        AI_RUNTIME_WORKER_STARTUP_TIMEOUT_MS: "45000"
      }),
      { timeoutMs: 45000 }
    );
    assert.throws(
      () =>
        resolveRuntimeWorkerStartupConfig({
          AI_RUNTIME_WORKER_STARTUP_TIMEOUT_MS: "0"
        }),
      /Invalid AI_RUNTIME_WORKER_STARTUP_TIMEOUT_MS/
    );
  });

  it("opens only after every readiness dependency resolves", async () => {
    let resolveSecond;
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    const startup = waitForRuntimeWorkerStartup({
      readiness: [Promise.resolve(), second],
      timeoutMs: 1000
    });
    let settled = false;
    void startup.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    resolveSecond();
    await startup;
    assert.equal(settled, true);
  });

  it("maps raw readiness failures to a fixed error", async () => {
    await assert.rejects(
      waitForRuntimeWorkerStartup({
        readiness: [
          Promise.reject(
            new Error(
              "rediss://runtime-user:sensitive@redis.invalid"
            )
          )
        ],
        timeoutMs: 1000
      }),
      {
        message: "AI runtime worker startup failed"
      }
    );
  });

  it(
    "rejects a readiness promise that never settles",
    { timeout: 1000 },
    async () => {
      await assert.rejects(
        waitForRuntimeWorkerStartup({
          readiness: [new Promise(() => {})],
          timeoutMs: 10
        }),
        {
          message: "AI runtime worker startup timed out"
        }
      );
    }
  );

  it("rejects an empty or unbounded startup gate", async () => {
    await assert.rejects(
      waitForRuntimeWorkerStartup({
        readiness: [],
        timeoutMs: 1000
      }),
      /Invalid AI runtime worker startup gate/
    );
    await assert.rejects(
      waitForRuntimeWorkerStartup({
        readiness: [Promise.resolve()],
        timeoutMs: 0
      }),
      /Invalid AI runtime worker startup gate/
    );
  });
});
