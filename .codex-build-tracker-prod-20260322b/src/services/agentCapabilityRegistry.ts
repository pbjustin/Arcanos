/**
 * Capability registry mapping human-level capabilities to CEF commands.
 */

import { listAvailableCommands } from './commandCenter.js';
import { AgentPlanningValidationError } from './agentPlanningErrors.js';
import type {
  AgentCapabilityPlanningContext,
  AgentPlannedCapabilityStep,
  CapabilityRegistryEntry
} from './agentExecutionTypes.js';
import type {
  CommandExecutionContext,
  CommandExecutionResult,
  CommandName
} from './commandCenter.js';

const AUDIT_SAFE_MODE_VALUES = ['true', 'false', 'passive', 'log-only'] as const;

function getTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveAuditSafeModeFromGoal(
  context: AgentCapabilityPlanningContext
): (typeof AUDIT_SAFE_MODE_VALUES)[number] | null {
  const explicitMode = getTrimmedString(context.requestPayload.mode) ?? getTrimmedString(context.requestPayload.auditSafeMode);
  if (explicitMode && AUDIT_SAFE_MODE_VALUES.includes(explicitMode as (typeof AUDIT_SAFE_MODE_VALUES)[number])) {
    return explicitMode as (typeof AUDIT_SAFE_MODE_VALUES)[number];
  }

  const normalizedGoal = context.goal.toLowerCase();

  //audit Assumption: operator goals describe the desired audit-safe mode in plain English; failure risk: ambiguous audit-mode goals map to the wrong CEF command payload; expected invariant: only clear mode phrases are converted to a direct mode value; handling strategy: match explicit phrases conservatively and return null when unclear.
  if (/\b(log[- ]only)\b/.test(normalizedGoal)) {
    return 'log-only';
  }

  if (/\bpassive\b/.test(normalizedGoal)) {
    return 'passive';
  }

  if (/\b(disable|turn off)\b/.test(normalizedGoal)) {
    return 'false';
  }

  if (/\b(enable|turn on|strict)\b/.test(normalizedGoal)) {
    return 'true';
  }

  return null;
}

function buildAuditSafeModePayload(context: AgentCapabilityPlanningContext): Record<string, unknown> {
  const resolvedMode = resolveAuditSafeModeFromGoal(context);

  //audit Assumption: direct audit-safe mode control requires an explicit target mode; failure risk: the planner emits a mutating CEF command with an invalid or missing mode; expected invariant: `audit-safe:set-mode` always receives one supported mode value; handling strategy: throw early so the caller can return a structured validation error.
  if (!resolvedMode) {
    throw new AgentPlanningValidationError(
      'AGENT_INVALID_AUDIT_MODE',
      'Capability "audit-safe-mode-control" requires a resolvable audit-safe mode.'
    );
  }

  return {
    mode: resolvedMode
  };
}

function buildAuditInstructionPayload(context: AgentCapabilityPlanningContext): Record<string, unknown> {
  const explicitInstruction = getTrimmedString(context.requestPayload.instruction);
  return {
    instruction: explicitInstruction ?? context.goal
  };
}

function buildGoalFulfillmentPayload(context: AgentCapabilityPlanningContext): Record<string, unknown> {
  const explicitPrompt = getTrimmedString(context.requestPayload.prompt);
  return {
    prompt: explicitPrompt ?? context.goal
  };
}

const CAPABILITY_REGISTRY: Record<string, CapabilityRegistryEntry> = {
  'audit-safe-mode-control': {
    capabilityId: 'audit-safe-mode-control',
    label: 'Audit Safe Mode Control',
    description: 'Set the Audit-Safe mode directly through the CEF.',
    cefCommandName: 'audit-safe:set-mode',
    buildCapabilityPayload: buildAuditSafeModePayload
  },
  'audit-safe-instruction-routing': {
    capabilityId: 'audit-safe-instruction-routing',
    label: 'Audit Instruction Routing',
    description: 'Interpret a human audit-safety instruction and route it through the CEF.',
    cefCommandName: 'audit-safe:interpret',
    buildCapabilityPayload: buildAuditInstructionPayload
  },
  'goal-fulfillment': {
    capabilityId: 'goal-fulfillment',
    label: 'Goal Fulfillment',
    description: 'Run the goal as a prompt through the CEF AI command.',
    cefCommandName: 'ai:prompt',
    buildCapabilityPayload: buildGoalFulfillmentPayload
  }
};

function assertCapabilityRegistryCommandsExist(): void {
  const commandNames = new Set(listAvailableCommands().map(command => command.name));

  for (const capability of Object.values(CAPABILITY_REGISTRY)) {
    //audit Assumption: the capability registry must not drift from the actual CEF command surface; failure risk: planning succeeds but execution fails with unsupported-command errors; expected invariant: every mapped capability targets a registered command; handling strategy: throw during registry access when a mapping is stale.
    if (!commandNames.has(capability.cefCommandName)) {
      throw new Error(`Capability "${capability.capabilityId}" references missing CEF command "${capability.cefCommandName}".`);
    }
  }
}

/**
 * List registered human-level capabilities backed by the CEF.
 *
 * Purpose:
 * - Expose the supported capability-to-command mappings to planners and diagnostics.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: sorted capability registry entries.
 *
 * Edge case behavior:
 * - Throws when the registry points at a missing CEF command to prevent stale mappings from executing.
 */
export function listCapabilityRegistryEntries(): CapabilityRegistryEntry[] {
  assertCapabilityRegistryCommandsExist();
  return Object.values(CAPABILITY_REGISTRY).sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
}

/**
 * Resolve one capability definition by id.
 *
 * Purpose:
 * - Give the planner a deterministic lookup from requested capability ids to CEF-backed definitions.
 *
 * Inputs/outputs:
 * - Input: capability identifier.
 * - Output: capability definition or `null`.
 *
 * Edge case behavior:
 * - Returns `null` when the capability id is unknown instead of inventing a fallback mapping.
 */
export function getCapabilityRegistryEntry(capabilityId: string): CapabilityRegistryEntry | null {
  assertCapabilityRegistryCommandsExist();
  return CAPABILITY_REGISTRY[capabilityId] ?? null;
}

/**
 * Determine whether the provided goal clearly targets an audit-safe mode mutation.
 *
 * Purpose:
 * - Let the planner distinguish direct mode-setting goals from general prompt execution goals.
 *
 * Inputs/outputs:
 * - Input: planning context containing the goal and request payload.
 * - Output: boolean indicating whether a direct mode mutation is supported.
 *
 * Edge case behavior:
 * - Returns `false` when the goal mentions audit safety without a resolvable target mode.
 */
export function hasResolvableAuditSafeModeGoal(context: AgentCapabilityPlanningContext): boolean {
  return resolveAuditSafeModeFromGoal(context) !== null;
}

/**
 * Detect whether the goal references audit-safe interpretation behavior.
 *
 * Purpose:
 * - Help the planner select the interpret capability when the goal targets audit-safe instruction handling.
 *
 * Inputs/outputs:
 * - Input: planning context.
 * - Output: boolean describing whether the goal mentions audit-safe behavior.
 *
 * Edge case behavior:
 * - Prefers explicit request payload instructions when present.
 */
export function isAuditInstructionGoal(context: AgentCapabilityPlanningContext): boolean {
  if (getTrimmedString(context.requestPayload.instruction)) {
    return true;
  }

  return /\baudit[- ]safe\b|\bsafe mode\b/i.test(context.goal);
}

/**
 * Detect whether the goal needs a normal AI prompt execution step.
 *
 * Purpose:
 * - Prevent mode-only audit goals from being redundantly re-sent as prompt commands.
 *
 * Inputs/outputs:
 * - Input: planning context plus already-selected capability ids.
 * - Output: boolean indicating whether `ai:prompt` should be scheduled.
 *
 * Edge case behavior:
 * - Explicit prompt payloads always force the goal-fulfillment capability.
 */
export function shouldPlanGoalFulfillmentCapability(
  context: AgentCapabilityPlanningContext,
  selectedCapabilityIds: string[]
): boolean {
  if (getTrimmedString(context.requestPayload.prompt)) {
    return true;
  }

  if (selectedCapabilityIds.length === 0) {
    return true;
  }

  const normalizedGoal = context.goal.toLowerCase();
  const containsFollowOnConnector = /\b(and|then|also|after|while)\b/.test(normalizedGoal);
  const containsNonAuditTaskVerb = /\b(answer|analyze|build|describe|explain|generate|plan|respond|return|review|summarize|write)\b/.test(normalizedGoal);

  //audit Assumption: a pure audit-mode mutation should not automatically spawn a second AI prompt step; failure risk: mode-only goals unexpectedly incur model calls and side effects; expected invariant: `goal-fulfillment` is added only when the goal still contains substantive non-mode work; handling strategy: require an explicit prompt, a connector, or a task verb once another capability is already selected.
  return containsFollowOnConnector || containsNonAuditTaskVerb;
}

/**
 * Dispatch one planned capability through its mapped CEF command.
 *
 * Purpose:
 * - Keep the capability layer as the only component that translates capability steps into concrete CEF command calls.
 *
 * Inputs/outputs:
 * - Input: planned capability step, command executor, and CEF trace context.
 * - Output: structured CEF command result.
 *
 * Edge case behavior:
 * - Throws when the capability is unknown so callers cannot bypass the registry with ad-hoc command execution.
 */
export async function dispatchCapabilityViaCef(
  step: AgentPlannedCapabilityStep,
  commandExecutor: (
    command: CommandName,
    payload?: Record<string, unknown>,
    context?: CommandExecutionContext
  ) => Promise<CommandExecutionResult>,
  context: CommandExecutionContext
): Promise<CommandExecutionResult> {
  const capability = getCapabilityRegistryEntry(step.capabilityId);

  //audit Assumption: execution steps must resolve back to a registered capability before any CEF dispatch occurs; failure risk: agent code bypasses the registry with stale or fabricated step data; expected invariant: every planned step references a known capability; handling strategy: throw on unknown capabilities so the caller fails closed.
  if (!capability) {
    throw new AgentPlanningValidationError(
      'AGENT_UNKNOWN_CAPABILITY',
      `Unknown capability "${step.capabilityId}".`
    );
  }

  return commandExecutor(capability.cefCommandName, step.capabilityPayload, context);
}
