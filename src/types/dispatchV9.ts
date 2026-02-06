/**
 * Dispatch v9 shared types.
 *
 * Defines immutable contracts for pattern bindings, memory snapshots,
 * route-attempt validation, and middleware decisions.
 */

export type DispatchDecisionV9 = 'allow' | 'reroute' | 'block';

export type DispatchSensitivityV9 = 'sensitive' | 'non-sensitive';

export type DispatchConflictPolicyV9 = 'refresh_then_reroute' | 'strict_block';

export type DispatchMatchKindV9 = 'exact' | 'regex' | 'intent';

export type DispatchConflictReasonV9 =
  | 'none'
  | 'missing_binding'
  | 'missing_route_state'
  | 'stale_version'
  | 'route_drift'
  | 'hard_conflict';

export interface DispatchPatternBindingV9 {
  id: string;
  priority: number;
  methods: string[];
  exactPaths?: string[];
  pathRegexes?: string[];
  pathTemplates?: string[];
  intentHints?: string[];
  sensitivity: DispatchSensitivityV9;
  conflictPolicy: DispatchConflictPolicyV9;
  rerouteTarget?: '/api/ask';
  expectedRoute: string;
  exempt?: boolean;
}

export interface DispatchResolvedBindingV9 extends DispatchPatternBindingV9 {
  matchKind: DispatchMatchKindV9;
}

export interface DispatchAttemptV9 {
  method: string;
  path: string;
  routeAttempted: string;
  intentHints: string[];
}

export interface DispatchRouteStateV9 {
  expected_route: string;
  last_validated_at: string;
  hard_conflict: boolean;
}

export interface DispatchMemorySnapshotV9 {
  schema_version: 'v9';
  bindings_version: string;
  memory_version: string;
  route_state: Record<string, DispatchRouteStateV9>;
  updated_at: string;
  updated_by: string;
}

export interface DispatchValidationResultV9 {
  valid: boolean;
  reason: DispatchConflictReasonV9;
  requiresSnapshotUpdate: boolean;
  hardConflict: boolean;
}

