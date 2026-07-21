export interface ActionPlanExecutionRuntimeControls {
  protocolEnabled: boolean;
  acceptCommands: boolean;
  assignRequested: boolean;
  drainEnabled: boolean;
}

function enabled(value: string | undefined): boolean {
  return value === 'true';
}

export function resolveActionPlanExecutionRuntimeControls(
  env: NodeJS.ProcessEnv = process.env,
): ActionPlanExecutionRuntimeControls {
  return {
    protocolEnabled: enabled(env.ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED),
    acceptCommands: enabled(env.ACTION_PLAN_EXECUTION_ACCEPT_COMMANDS),
    assignRequested: enabled(env.ACTION_PLAN_EXECUTION_ASSIGN_REQUESTED),
    drainEnabled: enabled(env.ACTION_PLAN_EXECUTION_DRAIN_ENABLED),
  };
}
