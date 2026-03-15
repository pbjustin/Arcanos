import envelopeSchema from "../schemas/v1/envelope.schema.json" with { type: "json" };
import contextInspectRequestSchema from "../schemas/v1/commands/context.inspect.request.schema.json" with { type: "json" };
import contextInspectResponseSchema from "../schemas/v1/commands/context.inspect.response.schema.json" with { type: "json" };
import execStartRequestSchema from "../schemas/v1/commands/exec.start.request.schema.json" with { type: "json" };
import execStartResponseSchema from "../schemas/v1/commands/exec.start.response.schema.json" with { type: "json" };
import toolRegistryRequestSchema from "../schemas/v1/commands/tool.registry.request.schema.json" with { type: "json" };
import toolRegistryResponseSchema from "../schemas/v1/commands/tool.registry.response.schema.json" with { type: "json" };
import approvalSchema from "../schemas/v1/nouns/approval.schema.json" with { type: "json" };
import artifactSchema from "../schemas/v1/nouns/artifact.schema.json" with { type: "json" };
import contextSchema from "../schemas/v1/nouns/context.schema.json" with { type: "json" };
import environmentSchema from "../schemas/v1/nouns/environment.schema.json" with { type: "json" };
import executionStateSchema from "../schemas/v1/nouns/execution-state.schema.json" with { type: "json" };
import patchSchema from "../schemas/v1/nouns/patch.schema.json" with { type: "json" };
import planSchema from "../schemas/v1/nouns/plan.schema.json" with { type: "json" };
import projectSchema from "../schemas/v1/nouns/project.schema.json" with { type: "json" };
import runResultSchema from "../schemas/v1/nouns/run-result.schema.json" with { type: "json" };
import taskSchema from "../schemas/v1/nouns/task.schema.json" with { type: "json" };
import toolSchema from "../schemas/v1/nouns/tool.schema.json" with { type: "json" };

/**
 * Returns the schema bundle shared across TypeScript and Python boundaries.
 * Inputs: none.
 * Outputs: immutable schema catalog keyed by nouns, commands, and the envelope.
 * Edge cases: only the initial scaffolded commands are included until later protocol versions expand the catalog.
 */
export function getProtocolSchemaCatalog() {
  return {
    envelope: envelopeSchema,
    nouns: {
      approval: approvalSchema,
      artifact: artifactSchema,
      context: contextSchema,
      environment: environmentSchema,
      executionState: executionStateSchema,
      patch: patchSchema,
      plan: planSchema,
      project: projectSchema,
      runResult: runResultSchema,
      task: taskSchema,
      tool: toolSchema
    },
    commands: {
      contextInspect: {
        request: contextInspectRequestSchema,
        response: contextInspectResponseSchema
      },
      execStart: {
        request: execStartRequestSchema,
        response: execStartResponseSchema
      },
      toolRegistry: {
        request: toolRegistryRequestSchema,
        response: toolRegistryResponseSchema
      }
    }
  } as const;
}
