import { generateRequestId } from "@shared/idGenerator.js";
import { recordTraceEvent } from "@platform/logging/telemetry.js";
import { evaluate } from './policies.js';
import { getStatus } from './health.js';
import { logDecision } from './logger.js';
import { executeRoute as executeSelectedRoute } from './routes.js';
import { persistDecision } from './analytics.js';
import type { DecideInput, DecisionRecord, PolicyEvaluation, RouteExecutionResult, RouteSelection } from './types.js';
import { interpreterSupervisor } from '@services/safety/interpreterSupervisor.js';

export async function decide(input: DecideInput): Promise<DecisionRecord> {
  const intent = typeof input.intent === 'string' ? input.intent : 'default';
  return interpreterSupervisor.runSupervisedCycle(
    `afol:${intent}`,
    async (heartbeat: () => void) => {
      const started = Date.now();
      heartbeat();
      const snapshot = getStatus();
      const policy = evaluate(snapshot, intent);
      const route = selectRoute(policy);
      recordTraceEvent('afol.decision.route', {
        intent,
        route: route.name,
        reason: route.reason
      });
      heartbeat();
      const response = await executeSelectedRoute(route, input);

      const ok = route.name !== 'reject' && !response.error;
      const decisionId = generateRequestId('afol');

      const decision: DecisionRecord = {
        id: decisionId,
        ok,
        policy,
        route,
        response,
        meta: {
          latencyMs: Date.now() - started,
          timestamp: new Date().toISOString()
        }
      };

      heartbeat();
      await persistDecision(decision);
      logDecision(input, decision);
      recordTraceEvent('afol.decision.completed', {
        decisionId,
        ok,
        route: route.name,
        latencyMs: decision.meta.latencyMs
      });
      return decision;
    },
    {
      category: 'policy',
      metadata: { intent }
    }
  );
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

export function __selectRouteForTest(policy: PolicyEvaluation): RouteSelection {
  return selectRoute(policy);
}

export async function __executeRouteForTest(
  route: RouteSelection,
  input: DecideInput
): Promise<RouteExecutionResult> {
  return executeSelectedRoute(route, input);
}

export async function __runDecideWithoutSupervisorForTest(input: DecideInput): Promise<DecisionRecord> {
  const started = Date.now();
  const snapshot = getStatus();
  const intentForTest = typeof input.intent === 'string' ? input.intent : 'default';
  const policy = evaluate(snapshot, intentForTest);
  const route = selectRoute(policy);
  const response = await executeSelectedRoute(route, input);
  const ok = route.name !== 'reject' && !response.error;
  const decisionId = generateRequestId('afol');
  const decision: DecisionRecord = {
    id: decisionId,
    ok,
    policy,
    route,
    response,
    meta: {
      latencyMs: Date.now() - started,
      timestamp: new Date().toISOString()
    }
  };
  await persistDecision(decision);
  return decision;
}
