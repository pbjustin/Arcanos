import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AI_RUNTIME_PUBLIC_RESULT_LIMITS,
  projectPublicJobResult
} from "../dist/jobs/publicResult.js";
import { processQueuedAIJob } from "../dist/jobs/processJob.js";
import {
  createRuntimeTerminalReleaseHandler,
  createRuntimeWorkerProcessor
} from "../dist/jobs/workerProcessor.js";
import {
  AI_RUNTIME_ALLOWED_MODELS_ENV_NAME,
  AI_RUNTIME_DEFAULT_MAX_TOKENS_ENV_NAME,
  AI_RUNTIME_MAX_TOKENS_ENV_NAME,
  resolveRuntimeJobPolicy
} from "../dist/jobs/policy.js";
import {
  AI_RUNTIME_JOB_INPUT_LIMITS,
  validateCreateJobInput
} from "../dist/jobs/validation.js";

const BASE_INPUT = {
  model: "gpt-5",
  messages: [{ role: "user", content: "hello" }],
  maxTokens: 256,
  principalId: "operator:runtime-test"
};
const PRINCIPAL_ID = BASE_INPUT.principalId;
const JOB_POLICY = resolveRuntimeJobPolicy({
  [AI_RUNTIME_ALLOWED_MODELS_ENV_NAME]: "gpt-5,gpt-5-mini",
  [AI_RUNTIME_DEFAULT_MAX_TOKENS_ENV_NAME]: "512",
  [AI_RUNTIME_MAX_TOKENS_ENV_NAME]: "2048"
});
assert.ok(JOB_POLICY);

describe("standalone AI runtime job boundary", () => {
  it("accepts and owns representative text and structured message content", () => {
    const input = {
      model: " gpt-5 ",
      messages: [
        { role: "system", content: "Be concise." },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Describe this image." },
            {
              type: "input_image",
              image_url: "https://example.invalid/image.png"
            }
          ]
        }
      ],
      maxTokens: 512
    };

    const validation = validateCreateJobInput(input, JOB_POLICY);
    assert.equal(validation.ok, true);
    if (!validation.ok) {
      return;
    }

    assert.equal(validation.data.model, "gpt-5");
    assert.deepEqual(validation.data.messages, input.messages);
    assert.notEqual(validation.data.messages, input.messages);
    assert.notEqual(validation.data.messages[1], input.messages[1]);
    assert.notEqual(
      validation.data.messages[1].content,
      input.messages[1].content
    );
  });

  it("resolves a fail-closed exact model and token policy", () => {
    assert.equal(resolveRuntimeJobPolicy({}), null);
    assert.equal(Object.isFrozen(JOB_POLICY.allowedModels), true);
    assert.throws(() => {
      JOB_POLICY.allowedModels.push("injected-model");
    }, TypeError);
    assert.equal(
      resolveRuntimeJobPolicy({
        [AI_RUNTIME_ALLOWED_MODELS_ENV_NAME]: "gpt-5,gpt-5",
        [AI_RUNTIME_DEFAULT_MAX_TOKENS_ENV_NAME]: "512",
        [AI_RUNTIME_MAX_TOKENS_ENV_NAME]: "2048"
      }),
      null
    );
    assert.equal(
      resolveRuntimeJobPolicy({
        [AI_RUNTIME_ALLOWED_MODELS_ENV_NAME]: "gpt-5",
        [AI_RUNTIME_DEFAULT_MAX_TOKENS_ENV_NAME]: "4096",
        [AI_RUNTIME_MAX_TOKENS_ENV_NAME]: "2048"
      }),
      null
    );

    const defaulted = validateCreateJobInput(
      {
        model: "gpt-5",
        messages: [{ role: "user", content: "hello" }]
      },
      JOB_POLICY
    );
    assert.equal(defaulted.ok, true);
    if (defaulted.ok) {
      assert.equal(defaulted.data.maxTokens, 512);
    }

    const unconfiguredModel = validateCreateJobInput(
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }]
      },
      JOB_POLICY
    );
    assert.equal(unconfiguredModel.ok, false);

    const excessiveTokens = validateCreateJobInput(
      {
        model: "gpt-5",
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 2049
      },
      JOB_POLICY
    );
    assert.equal(excessiveTokens.ok, false);
  });

  it("rejects excessive nesting without recursive validation", () => {
    let content = "leaf";
    for (
      let depth = 0;
      depth < AI_RUNTIME_JOB_INPUT_LIMITS.maxDepth + 1000;
      depth += 1
    ) {
      content = [content];
    }

    const validation = validateCreateJobInput(
      {
        model: "gpt-5",
        messages: [{ role: "user", content }]
      },
      JOB_POLICY
    );

    assert.equal(validation.ok, false);
    if (!validation.ok) {
      assert.match(validation.error, /nesting depth/);
    }
  });

  it("rejects oversized arrays, object-key sets, and aggregate strings", () => {
    const oversizedArray = validateCreateJobInput(
      {
        model: "gpt-5",
        messages: [
          {
            role: "user",
            content: new Array(
              AI_RUNTIME_JOB_INPUT_LIMITS.maxArrayItems + 1
            ).fill("x")
          }
        ]
      },
      JOB_POLICY
    );
    assert.equal(oversizedArray.ok, false);

    const oversizedObject = validateCreateJobInput(
      {
        model: "gpt-5",
        messages: [
          {
            role: "user",
            content: Object.fromEntries(
              Array.from(
                {
                  length:
                    AI_RUNTIME_JOB_INPUT_LIMITS.maxObjectKeys + 1
                },
                (_, index) => [`key_${index}`, index]
              )
            )
          }
        ]
      },
      JOB_POLICY
    );
    assert.equal(oversizedObject.ok, false);

    const aggregateStringOverflow = validateCreateJobInput(
      {
        model: "gpt-5",
        messages: Array.from({ length: 4 }, () => ({
          role: "user",
          content: "x".repeat(50 * 1024)
        }))
      },
      JOB_POLICY
    );
    assert.equal(aggregateStringOverflow.ok, false);
    if (!aggregateStringOverflow.ok) {
      assert.match(aggregateStringOverflow.error, /aggregate UTF-8/);
    }
  });

  it("rejects repeated references, inherited objects, and reserved keys", () => {
    const repeated = { type: "input_text", text: "hello" };
    const repeatedReference = validateCreateJobInput(
      {
        model: "gpt-5",
        messages: [
          {
            role: "user",
            content: [repeated, repeated]
          }
        ]
      },
      JOB_POLICY
    );
    assert.equal(repeatedReference.ok, false);

    const inheritedContent = Object.create({ inherited: true });
    inheritedContent.type = "input_text";
    inheritedContent.text = "hello";
    const inheritedObject = validateCreateJobInput(
      {
        model: "gpt-5",
        messages: [{ role: "user", content: inheritedContent }]
      },
      JOB_POLICY
    );
    assert.equal(inheritedObject.ok, false);

    const reservedKey = validateCreateJobInput(
      JSON.parse(
        '{"model":"gpt-5","messages":[{"role":"user","content":{"__proto__":{"polluted":true}}}]}'
      ),
      JOB_POLICY
    );
    assert.equal(reservedKey.ok, false);
  });

  it("projects completed provider results to bounded public text", () => {
    const projection = projectPublicJobResult({
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
      metadata: { secret: "test-unknown-provider-field" }
    });

    assert.deepEqual(projection, {
      ok: true,
      result: { output_text: "done" }
    });
  });

  it("rejects resolved provider failures and unknown completed values", () => {
    assert.deepEqual(
      projectPublicJobResult({
        status: "failed",
        output_text: "should not be returned",
        error: { message: "provider failure detail" }
      }),
      { ok: false }
    );
    assert.deepEqual(
      projectPublicJobResult({ arbitrary: "unknown result" }),
      { ok: false }
    );
  });

  it("rejects non-completed provider statuses and refusals", () => {
    for (const status of [
      "incomplete",
      "cancelled",
      "queued",
      "in_progress",
      "future_status"
    ]) {
      assert.deepEqual(
        projectPublicJobResult({
          status,
          output_text: "must not be treated as complete",
          error: null
        }),
        { ok: false }
      );
    }

    assert.deepEqual(
      projectPublicJobResult({
        status: "completed",
        output_text: "partial output",
        incomplete_details: {
          reason: "content_filter",
          sentinel: "must not survive"
        }
      }),
      { ok: false }
    );

    assert.deepEqual(
      projectPublicJobResult({
        status: "completed",
        output_text: "",
        output: [
          {
            content: [
              {
                type: "refusal",
                refusal: "sensitive refusal detail"
              }
            ]
          }
        ]
      }),
      { ok: false }
    );

    assert.deepEqual(
      projectPublicJobResult({
        status: "completed",
        output_text: "completed output",
        error: null
      }),
      {
        ok: true,
        result: { output_text: "completed output" }
      }
    );
  });

  it("bounds public output text by UTF-8 bytes", () => {
    const sentinel = "must-not-survive";
    const projection = projectPublicJobResult({
      output_text:
        "🙂".repeat(AI_RUNTIME_PUBLIC_RESULT_LIMITS.maxOutputTextBytes) +
        sentinel
    });

    assert.equal(projection.ok, true);
    if (!projection.ok || !("output_text" in projection.result)) {
      return;
    }

    assert.equal(projection.result.truncated, true);
    assert.equal(projection.result.output_text.includes(sentinel), false);
    assert.ok(
      Buffer.byteLength(projection.result.output_text, "utf8") <=
        AI_RUNTIME_PUBLIC_RESULT_LIMITS.maxOutputTextBytes
    );
  });

  it("preserves only a validated timeout envelope", () => {
    const projection = projectPublicJobResult({
      status: "timeout_prevented",
      category: "runtime_budget_exhausted",
      stage: "reasoning",
      partial: false,
      confidence: null,
      elapsed_ms: 1200,
      remaining_budget_ms: 0,
      watchdog_limit_ms: 120000,
      trace_id: "123e4567-e89b-42d3-a456-426614174000",
      provider_error: "must not survive"
    });

    assert.equal(projection.ok, true);
    if (!projection.ok) {
      return;
    }
    assert.equal("provider_error" in projection.result, false);
    assert.deepEqual(projection.result, {
      status: "timeout_prevented",
      category: "runtime_budget_exhausted",
      stage: "reasoning",
      partial: false,
      confidence: null,
      elapsed_ms: 1200,
      remaining_budget_ms: 0,
      watchdog_limit_ms: 120000,
      trace_id: "123e4567-e89b-42d3-a456-426614174000"
    });
  });

  it("revalidates queued data and persists only a public projection", async () => {
    let executedInput;
    const result = await processQueuedAIJob(
      BASE_INPUT,
      {
        expectedPrincipalId: PRINCIPAL_ID,
        policy: JOB_POLICY,
        async execute(input) {
          executedInput = input;
          return {
            output_text: "safe output",
            output: [
              {
                type: "reasoning",
                encrypted_content: "must-not-be-persisted"
              }
            ]
          };
        }
      }
    );

    assert.deepEqual(executedInput, {
      model: BASE_INPUT.model,
      messages: BASE_INPUT.messages,
      maxTokens: BASE_INPUT.maxTokens
    });
    assert.notEqual(executedInput, BASE_INPUT);
    assert.deepEqual(result, { output_text: "safe output" });

    let executeCalls = 0;
    await assert.rejects(
      processQueuedAIJob(
        {
          model: "gpt-5",
          messages: [
            {
              role: "user",
              content: new Array(
                AI_RUNTIME_JOB_INPUT_LIMITS.maxArrayItems + 1
              ).fill("x")
            }
          ],
          principalId: PRINCIPAL_ID
        },
        {
          expectedPrincipalId: PRINCIPAL_ID,
          policy: JOB_POLICY,
          async execute() {
            executeCalls += 1;
            return { output_text: "unexpected" };
          }
        }
      ),
      /payload failed validation/
    );
    assert.equal(executeCalls, 0);
  });

  it("rejects unowned, reserved, malformed, and cross-principal queue jobs", async () => {
    for (const principalId of [
      undefined,
      "anonymous",
      " operator:runtime-test ",
      "operator:other"
    ]) {
      let executeCalls = 0;
      await assert.rejects(
        processQueuedAIJob(
          {
            ...BASE_INPUT,
            principalId
          },
          {
            expectedPrincipalId: PRINCIPAL_ID,
            policy: JOB_POLICY,
            async execute() {
              executeCalls += 1;
              return { output_text: "unexpected" };
            }
          }
        ),
        /ownership failed validation/
      );
      assert.equal(executeCalls, 0);
    }
  });

  it("enforces model policy again before queued provider execution", async () => {
    let executeCalls = 0;
    await assert.rejects(
      processQueuedAIJob(
        {
          ...BASE_INPUT,
          model: "unconfigured-model"
        },
        {
          expectedPrincipalId: PRINCIPAL_ID,
          policy: JOB_POLICY,
          async execute() {
            executeCalls += 1;
            return { output_text: "unexpected" };
          }
        }
      ),
      /payload failed validation/
    );
    assert.equal(executeCalls, 0);

    await assert.rejects(
      processQueuedAIJob(
        {
          ...BASE_INPUT,
          maxTokens: null
        },
        {
          expectedPrincipalId: PRINCIPAL_ID,
          policy: JOB_POLICY,
          async execute() {
            executeCalls += 1;
            return { output_text: "unexpected" };
          }
        }
      ),
      /payload failed validation/
    );
    assert.equal(executeCalls, 0);
  });

  it("requires a distributed admission claim before worker execution", async () => {
    for (const claim of [
      "already_claimed",
      "missing",
      "wrong_owner"
    ]) {
      let executeCalls = 0;
      let releaseCalls = 0;
      const processor = createRuntimeWorkerProcessor({
        admission: {
          async consumeEnqueueRate() {
            return { kind: "allowed" };
          },
          async reserve() {
            return { kind: "granted" };
          },
          async confirmQueued() {
            return "confirmed";
          },
          async claimForExecution() {
            return claim;
          },
          async releaseTerminal() {
            releaseCalls += 1;
          }
        },
        expectedPrincipalId: PRINCIPAL_ID,
        policy: JOB_POLICY,
        async execute() {
          executeCalls += 1;
          return { output_text: "unexpected" };
        }
      });

      await assert.rejects(
        processor({
          id: "job-claim-test",
          token: "test-bullmq-claim-token",
          data: BASE_INPUT
        }),
        /admission claim failed/
      );
      assert.equal(executeCalls, 0);
      assert.equal(releaseCalls, 0);
    }
  });

  it("holds worker reservations until BullMQ reports terminal state", async () => {
    const releaseCalls = [];
    let shouldFail = false;
    const processor = createRuntimeWorkerProcessor({
      admission: {
        async consumeEnqueueRate() {
          return { kind: "allowed" };
        },
        async reserve() {
          return { kind: "granted" };
        },
        async confirmQueued() {
          return "confirmed";
        },
        async claimForExecution() {
          return "claimed";
        },
        async releaseTerminal(jobId, principalId, claimId) {
          releaseCalls.push({ jobId, principalId, claimId });
        }
      },
      expectedPrincipalId: PRINCIPAL_ID,
      policy: JOB_POLICY,
      async execute() {
        if (shouldFail) {
          throw new Error("provider failure");
        }
        return { output_text: "done" };
      }
    });

    assert.deepEqual(
      await processor({
        id: "job-success",
        token: "test-bullmq-success-token",
        data: BASE_INPUT
      }),
      { output_text: "done" }
    );
    shouldFail = true;
    await assert.rejects(
      processor({
        id: "job-failure",
        token: "test-bullmq-failure-token",
        data: BASE_INPUT
      }),
      /provider failure/
    );

    assert.deepEqual(releaseCalls, []);
  });

  it("releases only from terminal handlers and defers transient failures", async () => {
    const loggerEvents = [];
    const releaseCalls = [];
    const admission = {
      async consumeEnqueueRate() {
        return { kind: "allowed" };
      },
      async reserve() {
        return { kind: "granted" };
      },
      async confirmQueued() {
        return "confirmed";
      },
      async claimForExecution() {
        return "claimed";
      },
      async releaseTerminal(jobId, principalId, claimId) {
        releaseCalls.push({ jobId, principalId, claimId });
      }
    };
    const terminalHandler = createRuntimeTerminalReleaseHandler(
      admission,
      PRINCIPAL_ID,
      {
        error(event) {
          loggerEvents.push(event);
        }
      }
    );

    await terminalHandler({
      id: "job-completed",
      token: "test-bullmq-completed-token",
      data: BASE_INPUT
    });
    assert.deepEqual(releaseCalls, [
      {
        jobId: "job-completed",
        principalId: PRINCIPAL_ID,
        claimId: "test-bullmq-completed-token"
      }
    ]);

    const deferredHandler = createRuntimeTerminalReleaseHandler(
      {
        async consumeEnqueueRate() {
          return { kind: "allowed" };
        },
        async reserve() {
          return { kind: "granted" };
        },
        async confirmQueued() {
          return "confirmed";
        },
        async claimForExecution() {
          return "claimed";
        },
        async releaseTerminal() {
          throw new Error("sensitive Redis release detail");
        }
      },
      PRINCIPAL_ID,
      {
        error(event) {
          loggerEvents.push(event);
        }
      }
    );
    await deferredHandler({
      id: "job-release-deferred",
      token: "test-bullmq-deferred-token",
      data: BASE_INPUT
    });
    assert.deepEqual(loggerEvents, [
      "ai_runtime.admission.release_deferred"
    ]);
  });
});
