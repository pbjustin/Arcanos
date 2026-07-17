# Later dependency-boundary proposals

These proposals are evidence-backed recommendations only. They do not authorize import rewrites or cycle breaking in Phase 0/1.

## Proposal 1: isolate observability from database and worker-control initialization

- Evidence: `runtime-edges.json` contains the source edge and every back-edge below; all affected modules are members of `runtime-scc-1`.
- Affected files: `src/core/db/query.ts`; `src/platform/observability/appMetrics.ts`; `src/services/workerControlService.ts`; `src/core/db/index.ts`.
- Observed behavior: runtime imports make database queries, metrics registration, worker control, and database exports mutually reachable during module initialization.
- Confidence: high.
- Observation type: static deterministic runtime-import graph plus existing import-side-effect characterization.
- Source edge: `src/core/db/query.ts` → `src/platform/observability/appMetrics.ts`
- Target back-edge: `src/platform/observability/appMetrics.ts` → `src/services/workerControlService.ts` → `src/core/db/index.ts`
- Why risky: database query infrastructure, global metrics registration, worker control, and repository exports initialize inside the 67-module SCC. Import order can expose partially initialized facades and native monitoring side effects.
- Suggested inversion point: a narrow metrics-recording interface supplied by composition root, with worker-state observation registered after database initialization.
- Required characterization tests: metric registry initialization, event-loop monitor lifecycle, database-disconnected metrics, worker-control startup, module-loader side effects.
- Risk: critical.
- Suggested implementation phase: Phase 3, after Phase 2 ownership and initialization decisions.
- Rollback: restore direct metrics imports and original composition order one edge at a time.
- Production deployment required: yes.

## Proposal 2: separate writing-plane contracts from runtime inspection/self-heal

- Evidence: the cited path is present in `runtime-edges.json` and closes through modules listed in `runtime-scc-1`.
- Affected files: `src/core/logic/trinityGenerationFacade.ts`; `src/platform/runtime/writingPlaneContract.ts`; `src/services/runtimeInspectionRoutingService.ts`; `src/services/arcanos-core.ts`.
- Observed behavior: the writing-plane contract reaches runtime inspection and self-heal code that reaches the writing pipeline again.
- Confidence: high.
- Observation type: static deterministic runtime-import graph.
- Source edge: `src/core/logic/trinityGenerationFacade.ts` → `src/platform/runtime/writingPlaneContract.ts`
- Target path back into writing: `writingPlaneContract.ts` → `src/services/runtimeInspectionRoutingService.ts` → self-heal/predictive services → `src/services/arcanos-core.ts` → GPT dispatch → Trinity.
- Why risky: the writing contract reaches operational inspection and self-heal services, which then reach the writing pipeline again. This makes control-plane availability and writing-plane initialization mutually dependent.
- Suggested inversion point: a read-only runtime-inspection port owned by the control plane; writing code consumes only a serializable inspection result contract.
- Required characterization tests: GPT plane classification, runtime diagnostics route, root diagnostics, predictive healing routing, Trinity direct-answer behavior.
- Risk: high.
- Suggested implementation phase: Phase 3.
- Rollback: restore the direct runtime-inspection import and original routing fallback.
- Production deployment required: yes.

## Proposal 3: decouple GPT route registration from dynamic module routes

- Evidence: the route/module edges are present in `runtime-edges.json`; loader import, cache, ordering, and failure behavior are covered by the module-loader characterization.
- Affected files: `src/routes/_core/gptDispatch.ts`; `src/routes/modules.ts`; `src/services/moduleLoader.ts`.
- Observed behavior: GPT route initialization and dynamic service discovery participate in the same 67-module runtime SCC.
- Confidence: high.
- Observation type: static deterministic runtime-import graph and fixture runtime characterization.
- Source edge: `src/routes/_core/gptDispatch.ts` → `src/routes/modules.ts`
- Target back-edge: `src/routes/modules.ts` → legacy GPT adapters/dispatch code.
- Why risky: route registration performs top-level dynamic module loading and participates in the runtime SCC. Loader failures, stale compiled files, or action-map mutation can affect GPT routing initialization.
- Suggested inversion point: an immutable module-registry snapshot passed to both route builders after safe discovery completes. This is not authorization for a production loader manifest.
- Required characterization tests: evaluated/accepted module inventory, cache semantics, duplicate route/action behavior, GPT router map rebuild, legacy route gates.
- Risk: high.
- Suggested implementation phase: Phase 3 after loader hardening.
- Rollback: restore top-level `loadModuleDefinitions` and existing map construction.
- Production deployment required: yes.

## Proposal 4: make control-plane MCP registration depend on a service port

- Evidence: `runtime-scc-2` lists all eight modules, and `runtime-edges.json` contains the cited service-to-transport and transport-to-service edges.
- Affected files: `src/services/controlPlane/service.ts`; `src/services/arcanosMcp.ts`; `src/mcp/server.ts`; `src/mcp/server/index.ts`; `src/mcp/server/controlPlaneTools.ts`.
- Observed behavior: control-plane execution and MCP transport/tool registration cannot be imported as independent acyclic layers.
- Confidence: high.
- Observation type: static deterministic runtime-import graph.
- Source edge: `src/services/controlPlane/service.ts` → `src/services/arcanosMcp.ts` → `src/mcp/server.ts`
- Target back-edge: `src/mcp/server/index.ts` and `controlPlaneTools.ts` → control-plane service/deep diagnostics/executor.
- Why risky: the entire eight-module SCC couples service execution to MCP transport registration and dynamic SDK import. Tool registration and control-plane implementation cannot initialize independently.
- Suggested inversion point: a transport-neutral control-plane executor/capability interface injected into MCP tool registration.
- Required characterization tests: control-plane service, executor approval, MCP control-plane tools, SDK-unavailable behavior, deep diagnostics.
- Risk: high.
- Suggested implementation phase: Phase 3.
- Rollback: restore direct service imports in MCP registration.
- Production deployment required: yes.

## Proposal 5: split queue/event persistence reads from global app metrics

- Evidence: `runtime-edges.json` contains the repository-to-query-to-metrics path and the return path through worker-control and repository modules in `runtime-scc-1`.
- Affected files: `src/core/db/repositories/jobEventRepository.ts`; `src/core/db/query.ts`; `src/platform/observability/appMetrics.ts`; `src/services/workerControlService.ts`; `src/queue/cleanup.ts`.
- Observed behavior: repository reads, metrics, worker status, and queue cleanup are mutually reachable at runtime-import time.
- Confidence: high.
- Observation type: static deterministic runtime-import graph.
- Source edge: `src/core/db/repositories/jobEventRepository.ts` → `src/core/db/query.ts` → `appMetrics.ts`
- Target path: `appMetrics.ts` → worker control/runtime config → job repositories and queue cleanup.
- Why risky: job-event reads, metrics, worker status, and queue cleanup share initialization and can amplify failures or circular imports during worker startup.
- Suggested inversion point: emit plain repository timing/result events to an optional observer registered outside repository modules.
- Required characterization tests: job event timeline, queue cleanup, repository disconnected behavior, app metrics reset, worker runtime startup.
- Risk: high.
- Suggested implementation phase: Phase 3.
- Rollback: restore repository-owned metric calls.
- Production deployment required: yes.

## Proposal 6: keep the 8-module MCP/control-plane SCC as the first bounded experiment

- Evidence: `runtime-scc-2` deterministically contains eight modules and is smaller than the 67-module SCC; its exact edges are in `runtime-edges.json`.
- Affected files: `src/mcp/server.ts`; `src/mcp/server/controlPlaneTools.ts`; `src/mcp/server/index.ts`; `src/services/arcanosMcp.ts`; `src/services/controlPlane/deepDiagnostics.ts`; `src/services/controlPlane/executor.ts`; `src/services/controlPlane/index.ts`; `src/services/controlPlane/service.ts`.
- Observed behavior: MCP transport registration, control-plane execution, approval, and diagnostics form one bounded runtime cycle.
- Confidence: high.
- Observation type: static deterministic runtime-import graph plus existing control-plane contract tests.
- Source SCC: listed as `runtime-scc-2` in `runtime-scc.json`.
- Why selected: it is smaller than the 67-module SCC, has clearer transport/service ownership, and already exposes contract tests.
- Suggested interface: control-plane request executor plus capability reader, with no MCP types in the service contract.
- Required characterization tests: all MCP control-plane tests, approval token matrix, deep diagnostics, SDK dynamic-import failure, request-context logging.
- Risk: high.
- Suggested implementation phase: Phase 3 pilot.
- Rollback: one commit restoring the original direct imports and registration.
- Production deployment required: yes.
