import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";

import { createRuntimeApp } from "../dist/app.js";
import {
  AI_RUNTIME_ACCESS_TOKEN_ENV_NAME,
  AI_RUNTIME_LEGACY_ANONYMOUS_PRINCIPAL_ID,
  AI_RUNTIME_PRINCIPAL_ID_ENV_NAME,
  AI_RUNTIME_PURPOSE_BOUND_PEER_ENV_NAMES,
  AI_RUNTIME_SCOPES_ENV_NAME,
  extractAiRuntimeBearerToken
} from "../dist/auth/runtimeHttpAuth.js";
import {
  AI_RUNTIME_ALLOWED_MODELS_ENV_NAME,
  AI_RUNTIME_DEFAULT_MAX_TOKENS_ENV_NAME,
  AI_RUNTIME_MAX_TOKENS_ENV_NAME
} from "../dist/jobs/policy.js";

const ACCESS_TOKEN = "test-runtime-http-access-token-1234567890";
const ROTATED_ACCESS_TOKEN = "test-runtime-http-rotated-token-123456789";
const PRINCIPAL_ID = "operator:runtime-test";
const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";

function configuredEnvironment(
  scopes = "runtime:enqueue,runtime:read"
) {
  return {
    [AI_RUNTIME_ACCESS_TOKEN_ENV_NAME]: ACCESS_TOKEN,
    [AI_RUNTIME_PRINCIPAL_ID_ENV_NAME]: PRINCIPAL_ID,
    [AI_RUNTIME_SCOPES_ENV_NAME]: scopes,
    [AI_RUNTIME_ALLOWED_MODELS_ENV_NAME]: "gpt-5,gpt-5-mini",
    [AI_RUNTIME_DEFAULT_MAX_TOKENS_ENV_NAME]: "512",
    [AI_RUNTIME_MAX_TOKENS_ENV_NAME]: "2048"
  };
}

function createQueuePort(overrides = {}) {
  const added = [];
  const requestedJobIds = [];
  const jobs = new Map();

  return {
    added,
    requestedJobIds,
    jobs,
    port: {
      async add(name, data, options) {
        added.push({ name, data, options });
        if (overrides.add) {
          return overrides.add(name, data, options);
        }
        return { id: options.jobId };
      },
      async getJob(jobId) {
        requestedJobIds.push(jobId);
        if (overrides.getJob) {
          return overrides.getJob(jobId);
        }
        return jobs.get(jobId) ?? null;
      }
    }
  };
}

function createAdmissionPort(overrides = {}) {
  const events = [];
  return {
    events,
    port: {
      async consumeEnqueueRate(principalId) {
        events.push({ operation: "rate", principalId });
        return overrides.consumeEnqueueRate
          ? overrides.consumeEnqueueRate(principalId)
          : { kind: "allowed" };
      },
      async reserve(input) {
        events.push({ operation: "reserve", ...input });
        return overrides.reserve
          ? overrides.reserve(input)
          : { kind: "granted" };
      },
      async confirmQueued(jobId, principalId) {
        events.push({
          operation: "confirm",
          jobId,
          principalId
        });
        return overrides.confirmQueued
          ? overrides.confirmQueued(jobId, principalId)
          : "confirmed";
      },
      async claimForExecution(jobId, principalId) {
        events.push({
          operation: "claim",
          jobId,
          principalId
        });
        return overrides.claimForExecution
          ? overrides.claimForExecution(jobId, principalId)
          : "claimed";
      },
      async releaseTerminal(jobId, principalId) {
        events.push({
          operation: "release",
          jobId,
          principalId
        });
        if (overrides.releaseTerminal) {
          await overrides.releaseTerminal(jobId, principalId);
        }
      }
    }
  };
}

function createJob(principalId, overrides = {}) {
  return {
    id: JOB_ID,
    data: {
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      principalId
    },
    timestamp: 1_700_000_000_000,
    processedOn: 1_700_000_000_100,
    finishedOn: 1_700_000_000_200,
    returnvalue: { output_text: "done" },
    failedReason: "sensitive provider detail",
    async getState() {
      return "completed";
    },
    ...overrides
  };
}

async function startRuntime(options = {}) {
  const queue = options.queue ?? createQueuePort();
  const admission =
    options.admission ?? createAdmissionPort();
  const loggerEvents = [];
  const app = createRuntimeApp({
    queue: queue.port,
    admission: admission.port,
    environment: options.environment ?? configuredEnvironment(),
    generateJobId: () => JOB_ID,
    logger: {
      error(event) {
        loggerEvents.push(event);
      }
    },
    ...(options.readiness
      ? { readiness: options.readiness }
      : {})
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    loggerEvents,
    admission,
    queue,
    async close() {
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function bearerHeaders(token = ACCESS_TOKEN) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

describe("standalone AI runtime HTTP security", () => {
  it("imports and constructs the app without initializing Redis or OpenAI", () => {
    const queue = createQueuePort();
    const admission = createAdmissionPort();
    assert.doesNotThrow(() => {
      createRuntimeApp({
        queue: queue.port,
        admission: admission.port,
        environment: {}
      });
    });
  });

  it("separates process liveness from Redis readiness", async () => {
    let ready = false;
    const runtime = await startRuntime({
      readiness: {
        isReady() {
          return ready;
        }
      }
    });
    try {
      for (const path of ["/health", "/healthz"]) {
        const response = await fetch(`${runtime.baseUrl}${path}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await readJson(response), {
          status: "ok"
        });
        assert.equal(
          response.headers.get("cache-control"),
          "no-store"
        );
      }

      const unavailable = await fetch(
        `${runtime.baseUrl}/readyz`
      );
      assert.equal(unavailable.status, 503);
      assert.deepEqual(await readJson(unavailable), {
        status: "unavailable"
      });

      ready = true;
      const available = await fetch(
        `${runtime.baseUrl}/readyz`
      );
      assert.equal(available.status, 200);
      assert.deepEqual(await readJson(available), {
        status: "ready"
      });
      assert.equal(runtime.queue.added.length, 0);
      assert.equal(runtime.queue.requestedJobIds.length, 0);
      assert.equal(runtime.admission.events.length, 0);
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when authentication configuration is unavailable", async () => {
    const runtime = await startRuntime({ environment: {} });
    try {
      const response = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: "{"
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await readJson(response), {
        error: {
          code: "AI_RUNTIME_AUTH_UNAVAILABLE",
          message: "AI runtime authentication is unavailable."
        }
      });
      assert.equal(runtime.queue.added.length, 0);
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when the runtime token reuses a peer credential", async () => {
    const peerEnvironmentName =
      AI_RUNTIME_PURPOSE_BOUND_PEER_ENV_NAMES[0];
    assert.equal(
      peerEnvironmentName,
      "ARCANOS_CONTROL_PLANE_ACCESS_TOKEN"
    );
    const environment = {
      ...configuredEnvironment(),
      [peerEnvironmentName]: ` ${ACCESS_TOKEN} `
    };
    const runtime = await startRuntime({ environment });

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs/${JOB_ID}`, {
        headers: bearerHeaders()
      });
      assert.equal(response.status, 503);
      assert.equal(runtime.queue.requestedJobIds.length, 0);
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when configured with the historical anonymous principal", async () => {
    const environment = {
      ...configuredEnvironment(),
      [AI_RUNTIME_PRINCIPAL_ID_ENV_NAME]:
        AI_RUNTIME_LEGACY_ANONYMOUS_PRINCIPAL_ID
    };
    const runtime = await startRuntime({ environment });

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs/${JOB_ID}`, {
        headers: bearerHeaders()
      });
      assert.equal(response.status, 503);
      assert.equal(runtime.queue.requestedJobIds.length, 0);
    } finally {
      await runtime.close();
    }
  });

  it("authenticates before parsing malformed or oversized request bodies", async () => {
    const runtime = await startRuntime();
    try {
      const malformedResponse = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      });
      assert.equal(malformedResponse.status, 401);

      const oversizedResponse = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({ payload: "x".repeat(300 * 1024) })
      });
      assert.equal(oversizedResponse.status, 413);
      assert.deepEqual(await readJson(oversizedResponse), {
        error: "Request body is too large"
      });
      assert.equal(runtime.queue.added.length, 0);
    } finally {
      await runtime.close();
    }
  });

  it("rejects deeply nested JSON before queue serialization", async () => {
    const runtime = await startRuntime();
    const nestedContent =
      "[".repeat(20_000) + '"leaf"' + "]".repeat(20_000);
    const body =
      '{"model":"gpt-5","messages":[{"role":"user","content":' +
      nestedContent +
      "}]}";

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body
      });

      assert.equal(response.status, 400);
      assert.match((await readJson(response)).error, /nesting depth/);
      assert.equal(runtime.queue.added.length, 0);
    } finally {
      await runtime.close();
    }
  });

  it("rejects missing, malformed, custom-header, and incorrect credentials", async () => {
    const runtime = await startRuntime();
    try {
      const requests = [
        {},
        { authorization: ACCESS_TOKEN },
        { "x-api-key": ACCESS_TOKEN },
        { authorization: "Bearer test-wrong-runtime-access-token-123456" }
      ];

      for (const headers of requests) {
        const response = await fetch(`${runtime.baseUrl}/jobs/${JOB_ID}`, {
          headers
        });
        assert.equal(response.status, 401);
        assert.match(
          response.headers.get("www-authenticate") ?? "",
          /Bearer realm="ai-runtime"/
        );
      }
      assert.equal(runtime.queue.requestedJobIds.length, 0);
    } finally {
      await runtime.close();
    }
  });

  it("rejects duplicate Authorization carriers", () => {
    const fakeRequest = {
      rawHeaders: [
        "Authorization",
        `Bearer ${ACCESS_TOKEN}`,
        "authorization",
        `Bearer ${ACCESS_TOKEN}`
      ],
      header(name) {
        return name.toLowerCase() === "authorization"
          ? `Bearer ${ACCESS_TOKEN}`
          : undefined;
      }
    };

    assert.equal(extractAiRuntimeBearerToken(fakeRequest), null);
  });

  it("requires the endpoint-specific scope before parsing or queue access", async () => {
    const readOnlyRuntime = await startRuntime({
      environment: configuredEnvironment("runtime:read")
    });
    try {
      const response = await fetch(`${readOnlyRuntime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: "{"
      });
      assert.equal(response.status, 403);
      assert.equal(readOnlyRuntime.queue.added.length, 0);
    } finally {
      await readOnlyRuntime.close();
    }

    const enqueueOnlyRuntime = await startRuntime({
      environment: configuredEnvironment("runtime:enqueue")
    });
    try {
      const response = await fetch(
        `${enqueueOnlyRuntime.baseUrl}/jobs/${JOB_ID}`,
        { headers: bearerHeaders() }
      );
      assert.equal(response.status, 403);
      assert.equal(enqueueOnlyRuntime.queue.requestedJobIds.length, 0);
    } finally {
      await enqueueOnlyRuntime.close();
    }
  });

  it("uses the server-owned principal when enqueuing a job", async () => {
    const runtime = await startRuntime();
    try {
      const response = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: "hello" }],
          principalId: "attacker-controlled"
        })
      });

      assert.equal(response.status, 202);
      assert.deepEqual(await readJson(response), {
        jobId: JOB_ID,
        status: "queued"
      });
      assert.equal(runtime.queue.added.length, 1);
      assert.equal(runtime.queue.added[0].data.principalId, PRINCIPAL_ID);
      assert.notEqual(
        runtime.queue.added[0].data.principalId,
        "attacker-controlled"
      );
      assert.equal(runtime.queue.added[0].data.maxTokens, 512);
      assert.deepEqual(
        runtime.admission.events.map((event) => event.operation),
        ["rate", "reserve", "confirm"]
      );
    } finally {
      await runtime.close();
    }
  });

  it("fails closed before parsing when job policy is unavailable", async () => {
    const environment = configuredEnvironment();
    delete environment[AI_RUNTIME_ALLOWED_MODELS_ENV_NAME];
    const runtime = await startRuntime({ environment });

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: "{"
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await readJson(response), {
        error: {
          code: "AI_RUNTIME_JOB_POLICY_UNAVAILABLE",
          message: "AI runtime job policy is unavailable."
        }
      });
      assert.equal(runtime.queue.added.length, 0);
    } finally {
      await runtime.close();
    }
  });

  it("enforces the configured model and output-token policy", async () => {
    const runtime = await startRuntime();

    try {
      const rejectedModel = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({
          model: "unconfigured-model",
          messages: [{ role: "user", content: "hello" }]
        })
      });
      assert.equal(rejectedModel.status, 400);
      assert.deepEqual(await readJson(rejectedModel), {
        error: "model is not permitted"
      });

      const rejectedTokens = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: "hello" }],
          maxTokens: 2049
        })
      });
      assert.equal(rejectedTokens.status, 400);
      assert.deepEqual(await readJson(rejectedTokens), {
        error: "maxTokens must be between 1 and 2048"
      });

      const rejectedNullTokens = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: "hello" }],
          maxTokens: null
        })
      });
      assert.equal(rejectedNullTokens.status, 400);
      assert.deepEqual(await readJson(rejectedNullTokens), {
        error: "maxTokens must be an integer when provided"
      });
      assert.equal(runtime.queue.added.length, 0);
    } finally {
      await runtime.close();
    }
  });

  it("rate-limits before body parsing and queue access", async () => {
    const admission = createAdmissionPort({
      async consumeEnqueueRate() {
        return {
          kind: "rate_limited",
          retryAfterMs: 1500
        };
      }
    });
    const runtime = await startRuntime({ admission });

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: "{"
      });

      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "2");
      assert.deepEqual(await readJson(response), {
        error: {
          code: "AI_RUNTIME_RATE_LIMITED",
          message: "AI runtime enqueue rate limit exceeded."
        }
      });
      assert.equal(runtime.queue.added.length, 0);
      assert.deepEqual(
        runtime.admission.events.map((event) => event.operation),
        ["rate"]
      );
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when admission storage is unavailable", async () => {
    const admission = createAdmissionPort({
      async consumeEnqueueRate() {
        throw new Error("sensitive Redis detail");
      }
    });
    const runtime = await startRuntime({ admission });

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: "{"
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await readJson(response), {
        error: {
          code: "AI_RUNTIME_ADMISSION_UNAVAILABLE",
          message: "AI runtime admission is unavailable."
        }
      });
      assert.equal(runtime.queue.added.length, 0);
      assert.equal(
        JSON.stringify(runtime.loggerEvents).includes(
          "sensitive Redis detail"
        ),
        false
      );
    } finally {
      await runtime.close();
    }
  });

  it("rejects saturated queues before enqueue", async () => {
    const admission = createAdmissionPort({
      async reserve() {
        return {
          kind: "saturated",
          retryAfterMs: 4500
        };
      }
    });
    const runtime = await startRuntime({ admission });

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: "hello" }]
        })
      });

      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "5");
      assert.deepEqual(await readJson(response), {
        error: {
          code: "AI_RUNTIME_QUEUE_SATURATED",
          message: "AI runtime queue is at capacity."
        }
      });
      assert.equal(runtime.queue.added.length, 0);
      assert.deepEqual(
        runtime.admission.events.map((event) => event.operation),
        ["rate", "reserve"]
      );
    } finally {
      await runtime.close();
    }
  });

  it("retains an ambiguous reservation when enqueue fails", async () => {
    const queue = createQueuePort({
      async add() {
        throw new Error("sensitive enqueue failure");
      },
      async getJob() {
        return null;
      }
    });
    const runtime = await startRuntime({ queue });

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: "hello" }]
        })
      });

      assert.equal(response.status, 500);
      assert.deepEqual(await readJson(response), {
        error: "Failed to enqueue job"
      });
      assert.deepEqual(
        runtime.admission.events.map((event) => event.operation),
        ["rate", "reserve"]
      );
      assert.deepEqual(runtime.loggerEvents, [
        "ai_runtime.jobs.enqueue_failed"
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("returns same-principal jobs and protects HEAD with read scope", async () => {
    const runtime = await startRuntime();
    runtime.queue.jobs.set(JOB_ID, createJob(PRINCIPAL_ID));

    try {
      const getResponse = await fetch(`${runtime.baseUrl}/jobs/${JOB_ID}`, {
        headers: bearerHeaders()
      });
      assert.equal(getResponse.status, 200);
      assert.equal((await readJson(getResponse)).status, "completed");

      const headResponse = await fetch(`${runtime.baseUrl}/jobs/${JOB_ID}`, {
        method: "HEAD",
        headers: bearerHeaders()
      });
      assert.equal(headResponse.status, 200);
      assert.equal(await headResponse.text(), "");
      assert.equal(runtime.queue.requestedJobIds.length, 2);
    } finally {
      await runtime.close();
    }
  });

  it("returns an identical 404 for absent, legacy, and cross-principal jobs", async () => {
    const runtime = await startRuntime();

    try {
      const absentResponse = await fetch(
        `${runtime.baseUrl}/jobs/${JOB_ID}`,
        { headers: bearerHeaders() }
      );
      const absentBody = await readJson(absentResponse);
      assert.equal(absentResponse.status, 404);

      runtime.queue.jobs.set(JOB_ID, createJob(undefined));
      const legacyResponse = await fetch(
        `${runtime.baseUrl}/jobs/${JOB_ID}`,
        { headers: bearerHeaders() }
      );
      assert.equal(legacyResponse.status, 404);
      assert.deepEqual(await readJson(legacyResponse), absentBody);

      runtime.queue.jobs.set(
        JOB_ID,
        createJob(AI_RUNTIME_LEGACY_ANONYMOUS_PRINCIPAL_ID)
      );
      const anonymousLegacyResponse = await fetch(
        `${runtime.baseUrl}/jobs/${JOB_ID}`,
        { headers: bearerHeaders() }
      );
      assert.equal(anonymousLegacyResponse.status, 404);
      assert.deepEqual(await readJson(anonymousLegacyResponse), absentBody);

      runtime.queue.jobs.set(JOB_ID, createJob("operator:other"));
      const crossPrincipalResponse = await fetch(
        `${runtime.baseUrl}/jobs/${JOB_ID}`,
        { headers: bearerHeaders() }
      );
      assert.equal(crossPrincipalResponse.status, 404);
      assert.deepEqual(await readJson(crossPrincipalResponse), absentBody);
    } finally {
      await runtime.close();
    }
  });

  it("does not expose a failed job's provider error detail", async () => {
    const runtime = await startRuntime();
    runtime.queue.jobs.set(
      JOB_ID,
      createJob(PRINCIPAL_ID, {
        async getState() {
          return "failed";
        }
      })
    );

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs/${JOB_ID}`, {
        headers: bearerHeaders()
      });
      const body = await readJson(response);
      assert.equal(response.status, 200);
      assert.equal(body.error, "Job execution failed");
      assert.equal(
        JSON.stringify(body).includes("sensitive provider detail"),
        false
      );
    } finally {
      await runtime.close();
    }
  });

  it("projects completed provider results before returning them", async () => {
    const runtime = await startRuntime();
    runtime.queue.jobs.set(
      JOB_ID,
      createJob(PRINCIPAL_ID, {
        returnvalue: {
          id: "provider-response-id",
          status: "completed",
          output_text: "done",
          instructions: "hidden instructions",
          output: [
            {
              type: "reasoning",
              encrypted_content: "encrypted-reasoning-sentinel"
            }
          ],
          provider_error: "provider-error-sentinel",
          unknown: "unknown-field-sentinel"
        }
      })
    );

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs/${JOB_ID}`, {
        headers: bearerHeaders()
      });
      const body = await readJson(response);

      assert.equal(response.status, 200);
      assert.deepEqual(body.result, { output_text: "done" });
      const serializedBody = JSON.stringify(body);
      assert.equal(serializedBody.includes("provider-response-id"), false);
      assert.equal(
        serializedBody.includes("encrypted-reasoning-sentinel"),
        false
      );
      assert.equal(serializedBody.includes("provider-error-sentinel"), false);
      assert.equal(serializedBody.includes("unknown-field-sentinel"), false);
    } finally {
      await runtime.close();
    }
  });

  it("maps resolved provider failures to the fixed public failure", async () => {
    const runtime = await startRuntime();
    runtime.queue.jobs.set(
      JOB_ID,
      createJob(PRINCIPAL_ID, {
        returnvalue: {
          status: "failed",
          output_text: "provider-failure-output",
          error: {
            message: "sensitive resolved provider failure"
          }
        }
      })
    );

    try {
      const response = await fetch(`${runtime.baseUrl}/jobs/${JOB_ID}`, {
        headers: bearerHeaders()
      });
      const body = await readJson(response);

      assert.equal(response.status, 200);
      assert.equal(body.status, "failed");
      assert.equal(body.error, "Job execution failed");
      assert.equal("result" in body, false);
      assert.equal(
        JSON.stringify(body).includes("sensitive resolved provider failure"),
        false
      );
    } finally {
      await runtime.close();
    }
  });

  it("marks responses no-store and removes Express fingerprinting", async () => {
    const runtime = await startRuntime();
    try {
      const response = await fetch(`${runtime.baseUrl}/jobs/unknown`, {
        headers: bearerHeaders()
      });

      assert.equal(response.status, 400);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.has("x-powered-by"), false);
    } finally {
      await runtime.close();
    }
  });

  it("authenticates unknown job routes before returning JSON 404", async () => {
    const runtime = await startRuntime();
    try {
      const anonymousResponse = await fetch(
        `${runtime.baseUrl}/jobs/not-a-route/extra`
      );
      assert.equal(anonymousResponse.status, 401);

      const authenticatedResponse = await fetch(
        `${runtime.baseUrl}/jobs/not-a-route/extra`,
        { headers: bearerHeaders() }
      );
      assert.equal(authenticatedResponse.status, 404);
      assert.deepEqual(await readJson(authenticatedResponse), {
        error: "Route not found"
      });
    } finally {
      await runtime.close();
    }
  });

  it("resolves authentication once per request and supports token rotation", async () => {
    const environment = configuredEnvironment();
    const runtime = await startRuntime({ environment });
    runtime.queue.jobs.set(JOB_ID, createJob(PRINCIPAL_ID));

    try {
      const firstResponse = await fetch(`${runtime.baseUrl}/jobs/${JOB_ID}`, {
        headers: bearerHeaders()
      });
      assert.equal(firstResponse.status, 200);

      environment[AI_RUNTIME_ACCESS_TOKEN_ENV_NAME] = ROTATED_ACCESS_TOKEN;

      const oldTokenResponse = await fetch(
        `${runtime.baseUrl}/jobs/${JOB_ID}`,
        { headers: bearerHeaders() }
      );
      assert.equal(oldTokenResponse.status, 401);

      const rotatedResponse = await fetch(
        `${runtime.baseUrl}/jobs/${JOB_ID}`,
        { headers: bearerHeaders(ROTATED_ACCESS_TOKEN) }
      );
      assert.equal(rotatedResponse.status, 200);
    } finally {
      await runtime.close();
    }
  });
});
