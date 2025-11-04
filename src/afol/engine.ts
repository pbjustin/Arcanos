import { evaluate } from './policies.js';
import { getStatus } from './health.js';
import { logDecision } from './logger.js';
import { DecideInput, DecisionRecord, PolicyEvaluation, RouteExecutionResult, RouteSelection } from './types.js';

export async function decide(input: DecideInput): Promise<DecisionRecord> {
  const started = Date.now();
  const snapshot = getStatus();
  const intent = typeof input.intent === 'string' ? input.intent : 'default';
  const policy = evaluate(snapshot, intent);
  const route = selectRoute(policy);
  const response = await executeRoute(route, input);

  const decision: DecisionRecord = {
    ok: route.name !== 'reject',
    policy,
    route,
    response,
    meta: {
      latencyMs: Date.now() - started,
      timestamp: new Date().toISOString()
    }
  };

  logDecision(input, decision);
  return decision;
}

function selectRoute(policy: PolicyEvaluation): RouteSelection {
  if (policy.allow && policy.primaryAvailable) {
    return { name: 'primary', reason: 'Primary healthy' };
  }
  if (policy.allow && policy.backupAvailable) {
    return { name: 'backup', reason: 'Fallback engaged' };
  }
  return { name: 'reject', reason: 'No viable route' };
}

async function executeRoute(route: RouteSelection, input: DecideInput): Promise<RouteExecutionResult> {
  if (route.name === 'reject') {
    return { route: route.name, input: input.intent ?? 'default' };
  }

  // Placeholder for actual route execution logic
  return {
    route: route.name,
    input: input.intent ?? 'default'
  };
}

export function __selectRouteForTest(policy: PolicyEvaluation): RouteSelection {
  return selectRoute(policy);
}

export async function __executeRouteForTest(
  route: RouteSelection,
  input: DecideInput
): Promise<RouteExecutionResult> {
  return executeRoute(route, input);
}
