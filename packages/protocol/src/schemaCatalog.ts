import artifactStoreRequestSchema from "../schemas/v1/commands/artifact.store.request.schema.json" with { type: "json" };
import artifactStoreResponseSchema from "../schemas/v1/commands/artifact.store.response.schema.json" with { type: "json" };
import envelopeSchema from "../schemas/v1/envelope.schema.json" with { type: "json" };
import contextInspectRequestSchema from "../schemas/v1/commands/context.inspect.request.schema.json" with { type: "json" };
import contextInspectResponseSchema from "../schemas/v1/commands/context.inspect.response.schema.json" with { type: "json" };
import daemonCapabilitiesRequestSchema from "../schemas/v1/commands/daemon.capabilities.request.schema.json" with { type: "json" };
import daemonCapabilitiesResponseSchema from "../schemas/v1/commands/daemon.capabilities.response.schema.json" with { type: "json" };
import execStartRequestSchema from "../schemas/v1/commands/exec.start.request.schema.json" with { type: "json" };
import execStartResponseSchema from "../schemas/v1/commands/exec.start.response.schema.json" with { type: "json" };
import execStatusRequestSchema from "../schemas/v1/commands/exec.status.request.schema.json" with { type: "json" };
import execStatusResponseSchema from "../schemas/v1/commands/exec.status.response.schema.json" with { type: "json" };
import stateSnapshotRequestSchema from "../schemas/v1/commands/state.snapshot.request.schema.json" with { type: "json" };
import stateSnapshotResponseSchema from "../schemas/v1/commands/state.snapshot.response.schema.json" with { type: "json" };
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
      artifactStore: {
        request: artifactStoreRequestSchema,
        response: artifactStoreResponseSchema
      },
      contextInspect: {
        request: contextInspectRequestSchema,
        response: contextInspectResponseSchema
      },
      daemonCapabilities: {
        request: daemonCapabilitiesRequestSchema,
        response: daemonCapabilitiesResponseSchema
      },
      execStart: {
        request: execStartRequestSchema,
        response: execStartResponseSchema
      },
      execStatus: {
        request: execStatusRequestSchema,
        response: execStatusResponseSchema
      },
      stateSnapshot: {
        request: stateSnapshotRequestSchema,
        response: stateSnapshotResponseSchema
      },
      toolRegistry: {
        request: toolRegistryRequestSchema,
        response: toolRegistryResponseSchema
      }
    }
  } as const;
}
