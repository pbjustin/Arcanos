import artifactStoreRequestSchema from "../schemas/v1/commands/artifact.store.request.schema.json" with { type: "json" };
import artifactStoreResponseSchema from "../schemas/v1/commands/artifact.store.response.schema.json" with { type: "json" };
import envelopeSchema from "../schemas/v1/envelope.schema.json" with { type: "json" };
import contextInspectRequestSchema from "../schemas/v1/commands/context.inspect.request.schema.json" with { type: "json" };
import contextInspectResponseSchema from "../schemas/v1/commands/context.inspect.response.schema.json" with { type: "json" };
import daemonCapabilitiesRequestSchema from "../schemas/v1/commands/daemon.capabilities.request.schema.json" with { type: "json" };
import daemonCapabilitiesResponseSchema from "../schemas/v1/commands/daemon.capabilities.response.schema.json" with { type: "json" };
import execStartRequestSchema from "../schemas/v1/commands/exec.start.request.schema.json" with { type: "json" };
import execStartResponseSchema from "../schemas/v1/commands/exec.start.response.schema.json" with { type: "json" };
import planGenerateRequestSchema from "../schemas/v1/commands/plan.generate.request.schema.json" with { type: "json" };
import planGenerateResponseSchema from "../schemas/v1/commands/plan.generate.response.schema.json" with { type: "json" };
import execStatusRequestSchema from "../schemas/v1/commands/exec.status.request.schema.json" with { type: "json" };
import execStatusResponseSchema from "../schemas/v1/commands/exec.status.response.schema.json" with { type: "json" };
import stateSnapshotRequestSchema from "../schemas/v1/commands/state.snapshot.request.schema.json" with { type: "json" };
import stateSnapshotResponseSchema from "../schemas/v1/commands/state.snapshot.response.schema.json" with { type: "json" };
import taskCreateRequestSchema from "../schemas/v1/commands/task.create.request.schema.json" with { type: "json" };
import taskCreateResponseSchema from "../schemas/v1/commands/task.create.response.schema.json" with { type: "json" };
import toolDescribeRequestSchema from "../schemas/v1/commands/tool.describe.request.schema.json" with { type: "json" };
import toolDescribeResponseSchema from "../schemas/v1/commands/tool.describe.response.schema.json" with { type: "json" };
import toolInvokeRequestSchema from "../schemas/v1/commands/tool.invoke.request.schema.json" with { type: "json" };
import toolInvokeResponseSchema from "../schemas/v1/commands/tool.invoke.response.schema.json" with { type: "json" };
import toolRegistryRequestSchema from "../schemas/v1/commands/tool.registry.request.schema.json" with { type: "json" };
import toolRegistryResponseSchema from "../schemas/v1/commands/tool.registry.response.schema.json" with { type: "json" };
import approvalSchema from "../schemas/v1/nouns/approval.schema.json" with { type: "json" };
import artifactSchema from "../schemas/v1/nouns/artifact.schema.json" with { type: "json" };
import contextSchema from "../schemas/v1/nouns/context.schema.json" with { type: "json" };
import doctorImplementationInputSchema from "../schemas/v1/tools/doctor.implementation.input.schema.json" with { type: "json" };
import doctorImplementationOutputSchema from "../schemas/v1/tools/doctor.implementation.output.schema.json" with { type: "json" };
import environmentSchema from "../schemas/v1/nouns/environment.schema.json" with { type: "json" };
import executionStateSchema from "../schemas/v1/nouns/execution-state.schema.json" with { type: "json" };
import patchSchema from "../schemas/v1/nouns/patch.schema.json" with { type: "json" };
import planSchema from "../schemas/v1/nouns/plan.schema.json" with { type: "json" };
import projectSchema from "../schemas/v1/nouns/project.schema.json" with { type: "json" };
import remoteSourceSchema from "../schemas/v1/nouns/remote-source.schema.json" with { type: "json" };
import runResultSchema from "../schemas/v1/nouns/run-result.schema.json" with { type: "json" };
import taskSchema from "../schemas/v1/nouns/task.schema.json" with { type: "json" };
import toolSchema from "../schemas/v1/nouns/tool.schema.json" with { type: "json" };
import repoListInputSchema from "../schemas/v1/tools/repo.list.input.schema.json" with { type: "json" };
import repoListOutputSchema from "../schemas/v1/tools/repo.list.output.schema.json" with { type: "json" };
import repoListTreeInputSchema from "../schemas/v1/tools/repo.listTree.input.schema.json" with { type: "json" };
import repoListTreeOutputSchema from "../schemas/v1/tools/repo.listTree.output.schema.json" with { type: "json" };
import repoGetDiffInputSchema from "../schemas/v1/tools/repo.getDiff.input.schema.json" with { type: "json" };
import repoGetDiffOutputSchema from "../schemas/v1/tools/repo.getDiff.output.schema.json" with { type: "json" };
import repoGetLogInputSchema from "../schemas/v1/tools/repo.getLog.input.schema.json" with { type: "json" };
import repoGetLogOutputSchema from "../schemas/v1/tools/repo.getLog.output.schema.json" with { type: "json" };
import repoGetStatusInputSchema from "../schemas/v1/tools/repo.getStatus.input.schema.json" with { type: "json" };
import repoGetStatusOutputSchema from "../schemas/v1/tools/repo.getStatus.output.schema.json" with { type: "json" };
import repoReadFileInputSchema from "../schemas/v1/tools/repo.read_file.input.schema.json" with { type: "json" };
import repoReadFileOutputSchema from "../schemas/v1/tools/repo.read_file.output.schema.json" with { type: "json" };
import repoReadFileV2InputSchema from "../schemas/v1/tools/repo.readFile.input.schema.json" with { type: "json" };
import repoReadFileV2OutputSchema from "../schemas/v1/tools/repo.readFile.output.schema.json" with { type: "json" };
import repoSearchInputSchema from "../schemas/v1/tools/repo.search.input.schema.json" with { type: "json" };
import repoSearchOutputSchema from "../schemas/v1/tools/repo.search.output.schema.json" with { type: "json" };

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
      remoteSource: remoteSourceSchema,
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
      planGenerate: {
        request: planGenerateRequestSchema,
        response: planGenerateResponseSchema
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
      taskCreate: {
        request: taskCreateRequestSchema,
        response: taskCreateResponseSchema
      },
      toolDescribe: {
        request: toolDescribeRequestSchema,
        response: toolDescribeResponseSchema
      },
      toolInvoke: {
        request: toolInvokeRequestSchema,
        response: toolInvokeResponseSchema
      },
      toolRegistry: {
        request: toolRegistryRequestSchema,
        response: toolRegistryResponseSchema
      }
    },
    tools: {
      "doctor.implementation": {
        input: doctorImplementationInputSchema,
        output: doctorImplementationOutputSchema
      },
      repoList: {
        input: repoListInputSchema,
        output: repoListOutputSchema
      },
      "repo.listTree": {
        input: repoListTreeInputSchema,
        output: repoListTreeOutputSchema
      },
      "repo.getDiff": {
        input: repoGetDiffInputSchema,
        output: repoGetDiffOutputSchema
      },
      "repo.getLog": {
        input: repoGetLogInputSchema,
        output: repoGetLogOutputSchema
      },
      "repo.getStatus": {
        input: repoGetStatusInputSchema,
        output: repoGetStatusOutputSchema
      },
      repoReadFile: {
        input: repoReadFileInputSchema,
        output: repoReadFileOutputSchema
      },
      "repo.readFile": {
        input: repoReadFileV2InputSchema,
        output: repoReadFileV2OutputSchema
      },
      "repo.search": {
        input: repoSearchInputSchema,
        output: repoSearchOutputSchema
      }
    }
  } as const;
}
