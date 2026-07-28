import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveRuntimeShutdownConfig
} from "../dist/config/env.js";
import {
  createRuntimeShutdownCoordinator,
  createRuntimeWorkerShutdownHandlers,
  installRuntimeSignalHandlers
} from "../dist/lifecycle/shutdown.js";

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("standalone AI runtime shutdown lifecycle", () => {
  it("validates the bounded shutdown deadline", () => {
    assert.deepEqual(
      resolveRuntimeShutdownConfig({}),
      { timeoutMs: 10000 }
    );
    assert.deepEqual(
      resolveRuntimeShutdownConfig({
        AI_RUNTIME_SHUTDOWN_TIMEOUT_MS: "25000"
      }),
      { timeoutMs: 25000 }
    );
    assert.throws(
      () =>
        resolveRuntimeShutdownConfig({
          AI_RUNTIME_SHUTDOWN_TIMEOUT_MS: "0"
        }),
      /Invalid AI_RUNTIME_SHUTDOWN_TIMEOUT_MS/
    );
    assert.throws(
      () =>
        createRuntimeShutdownCoordinator({
          timeoutMs: 0,
          async graceful() {},
          force() {}
        }),
      /Invalid AI runtime shutdown timeout/
    );
  });

  it("runs graceful shutdown exactly once", async () => {
    const deferred = createDeferred();
    const events = [];
    const coordinator = createRuntimeShutdownCoordinator({
      timeoutMs: 1000,
      async graceful() {
        events.push("graceful:start");
        await deferred.promise;
        events.push("graceful:end");
      },
      force() {
        events.push("force");
      }
    });

    const first = coordinator.shutdown("SIGTERM");
    const second = coordinator.shutdown("SIGINT");
    assert.equal(first, second);
    assert.equal(coordinator.isShuttingDown(), true);
    deferred.resolve();

    assert.deepEqual(await first, {
      forced: false,
      ok: true,
      signal: "SIGTERM"
    });
    assert.deepEqual(events, [
      "graceful:start",
      "graceful:end"
    ]);
  });

  it("forces cleanup after a credential-free graceful failure", async () => {
    const events = [];
    const coordinator = createRuntimeShutdownCoordinator({
      timeoutMs: 1000,
      async graceful() {
        throw new Error(
          "rediss://runtime-user:sensitive@redis.invalid"
        );
      },
      force() {
        events.push("force");
      },
      logger: {
        error(event) {
          events.push(event);
        }
      }
    });

    assert.deepEqual(await coordinator.shutdown("SIGINT"), {
      forced: true,
      ok: false,
      signal: "SIGINT"
    });
    assert.deepEqual(events, [
      "ai_runtime.shutdown.failed",
      "force"
    ]);
  });

  it("forces cleanup when graceful shutdown exceeds its deadline", async () => {
    const events = [];
    const coordinator = createRuntimeShutdownCoordinator({
      timeoutMs: 10,
      graceful() {
        return new Promise(() => {});
      },
      force() {
        events.push("force");
      },
      logger: {
        error(event) {
          events.push(event);
        }
      }
    });

    assert.deepEqual(await coordinator.shutdown("SIGTERM"), {
      forced: true,
      ok: false,
      signal: "SIGTERM"
    });
    assert.deepEqual(events, [
      "ai_runtime.shutdown.timeout",
      "force"
    ]);
  });

  it("keeps force-close available while graceful worker drain waits", async () => {
    const pauseDeferred = createDeferred();
    const events = [];
    let closing;
    const handlers = createRuntimeWorkerShutdownHandlers({
      worker: {
        async pause(doNotWaitActive) {
          events.push(`pause:${doNotWaitActive}`);
          await pauseDeferred.promise;
        },
        close(force) {
          if (!closing) {
            events.push(`close:first:${force}`);
            closing = Promise.resolve();
          }
          return closing;
        }
      },
      async waitForTerminalReleases() {
        events.push("terminal-releases");
      },
      async closeQueue() {
        events.push("queue:close");
      }
    });

    const graceful = handlers.graceful();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["pause:false"]);

    await handlers.force();
    assert.deepEqual(events, [
      "pause:false",
      "close:first:true",
      "queue:close"
    ]);

    pauseDeferred.resolve();
    await graceful;
    assert.deepEqual(events, [
      "pause:false",
      "close:first:true",
      "queue:close",
      "terminal-releases",
      "queue:close"
    ]);
  });

  it("force-disconnects only after a graceful worker drain", async () => {
    const events = [];
    const handlers = createRuntimeWorkerShutdownHandlers({
      worker: {
        async pause(doNotWaitActive) {
          events.push(`pause:${doNotWaitActive}`);
        },
        async close(force) {
          events.push(`close:${force}`);
        }
      },
      async waitForTerminalReleases() {
        events.push("terminal-releases");
      },
      async closeQueue() {
        events.push("queue:close");
      }
    });

    await handlers.graceful();
    assert.deepEqual(events, [
      "pause:false",
      "close:true",
      "terminal-releases",
      "queue:close"
    ]);
  });

  it("registers both signals and marks forced exits unsuccessful", async () => {
    const listeners = new Map();
    const exitCodes = [];
    const target = {
      exitCode: undefined,
      exit(code) {
        exitCodes.push(code);
      },
      once(signal, listener) {
        listeners.set(signal, listener);
      }
    };
    const received = [];
    installRuntimeSignalHandlers(
      {
        isShuttingDown() {
          return received.length > 0;
        },
        async shutdown(signal) {
          received.push(signal);
          return { forced: true, ok: false, signal };
        }
      },
      target
    );

    assert.deepEqual(
      [...listeners.keys()].sort(),
      ["SIGINT", "SIGTERM"]
    );
    listeners.get("SIGTERM")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, ["SIGTERM"]);
    assert.equal(target.exitCode, 1);
    assert.deepEqual(exitCodes, [1]);
  });
});
