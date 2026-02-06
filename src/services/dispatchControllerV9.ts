import type {
  DispatchAttemptV9,
  DispatchDecisionV9,
  DispatchMemorySnapshotV9,
  DispatchPatternBindingV9,
  DispatchResolvedBindingV9,
  DispatchValidationResultV9
} from '../types/dispatchV9.js';

function normalizeMethod(method: string): string {
  return method.toUpperCase().trim();
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '/';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function templateMatches(pathTemplate: string, path: string): boolean {
  const escapedTemplate = pathTemplate
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+')
    .replace(/\*/g, '.*');
  const matcher = new RegExp(`^${escapedTemplate}$`);
  return matcher.test(path);
}

function scoreBindingCandidate(binding: DispatchPatternBindingV9): number {
  return binding.priority;
}

/**
 * Purpose: Resolve a route attempt to the highest-priority dispatch binding.
 * Inputs/Outputs: route attempt + binding list; returns resolved binding or null.
 * Edge cases: deterministic tie-breaking by lexical binding id.
 */
export function resolveBinding(
  attempt: DispatchAttemptV9,
  bindings: DispatchPatternBindingV9[]
): DispatchResolvedBindingV9 | null {
  const method = normalizeMethod(attempt.method);
  const path = normalizePath(attempt.path);

  const exactMatches: DispatchResolvedBindingV9[] = [];
  const regexMatches: DispatchResolvedBindingV9[] = [];
  const intentMatches: DispatchResolvedBindingV9[] = [];

  for (const binding of bindings) {
    //audit Assumption: method whitelist controls binding applicability; risk: false matches; invariant: method must match; handling: skip.
    if (!binding.methods.map(normalizeMethod).includes(method)) {
      continue;
    }

    //audit Assumption: exact path matching is highest confidence; risk: stale routes; invariant: exact path list checked first; handling: collect.
    if ((binding.exactPaths || []).map(normalizePath).includes(path)) {
      exactMatches.push({ ...binding, matchKind: 'exact' });
      continue;
    }

    const regexMatched = (binding.pathRegexes || []).some(pattern => new RegExp(pattern).test(path));
    const templateMatched = (binding.pathTemplates || []).some(template => templateMatches(template, path));
    //audit Assumption: regex/template matches indicate route family; risk: overbroad patterns; invariant: only matched routes proceed; handling: collect.
    if (regexMatched || templateMatched) {
      regexMatches.push({ ...binding, matchKind: 'regex' });
      continue;
    }

    const hasIntentMatch = (binding.intentHints || []).some(hint =>
      attempt.intentHints.some(intent => intent.toLowerCase() === hint.toLowerCase())
    );
    //audit Assumption: intent hints are fallback classification; risk: weak intent signals; invariant: used only after path checks; handling: collect.
    if (hasIntentMatch) {
      intentMatches.push({ ...binding, matchKind: 'intent' });
    }
  }

  const chooseBest = (candidates: DispatchResolvedBindingV9[]): DispatchResolvedBindingV9 | null => {
    if (candidates.length === 0) {
      return null;
    }
    const sorted = [...candidates].sort((left, right) => {
      const scoreDelta = scoreBindingCandidate(right) - scoreBindingCandidate(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.id.localeCompare(right.id);
    });
    return sorted[0];
  };

  return chooseBest(exactMatches) || chooseBest(regexMatches) || chooseBest(intentMatches);
}

/**
 * Purpose: Validate route attempt against memory snapshot state.
 * Inputs/Outputs: binding + attempt + snapshot + optional client version; returns validation result.
 * Edge cases: missing route state is valid but requires snapshot upsert.
 */
export function validateAgainstSnapshot(
  binding: DispatchPatternBindingV9 | null,
  attempt: DispatchAttemptV9,
  snapshot: DispatchMemorySnapshotV9 | null,
  clientVersion?: string
): DispatchValidationResultV9 {
  //audit Assumption: binding must exist for consistent policy evaluation; risk: undefined policy path; invariant: invalid when missing; handling: missing binding conflict.
  if (!binding) {
    return {
      valid: false,
      reason: 'missing_binding',
      requiresSnapshotUpdate: false,
      hardConflict: true
    };
  }

  //audit Assumption: snapshot required for route consistency checks; risk: stale routing decisions; invariant: invalid when snapshot missing; handling: missing binding-equivalent conflict.
  if (!snapshot) {
    return {
      valid: false,
      reason: 'missing_binding',
      requiresSnapshotUpdate: false,
      hardConflict: true
    };
  }

  //audit Assumption: client-provided memory version indicates staleness window; risk: mismatch false positives; invariant: mismatch marks stale; handling: request refresh.
  if (clientVersion && snapshot.memory_version && clientVersion !== snapshot.memory_version) {
    return {
      valid: false,
      reason: 'stale_version',
      requiresSnapshotUpdate: false,
      hardConflict: false
    };
  }

  const state = snapshot.route_state[attempt.routeAttempted];
  //audit Assumption: first-seen routes may be absent from snapshot; risk: missing governance coverage; invariant: allow + request update; handling: require upsert.
  if (!state) {
    return {
      valid: true,
      reason: 'missing_route_state',
      requiresSnapshotUpdate: true,
      hardConflict: false
    };
  }

  //audit Assumption: hard conflict flag indicates explicitly blocked route; risk: bypassing safety constraints; invariant: hard conflict always invalid; handling: block candidate.
  if (state.hard_conflict) {
    return {
      valid: false,
      reason: 'hard_conflict',
      requiresSnapshotUpdate: false,
      hardConflict: true
    };
  }

  //audit Assumption: expected route must match attempted route for consistency; risk: route drift execution; invariant: mismatch invalid; handling: route drift conflict.
  if (state.expected_route !== attempt.routeAttempted) {
    return {
      valid: false,
      reason: 'route_drift',
      requiresSnapshotUpdate: false,
      hardConflict: false
    };
  }

  return {
    valid: true,
    reason: 'none',
    requiresSnapshotUpdate: false,
    hardConflict: false
  };
}

/**
 * Purpose: Convert validation result + policy to a final middleware action.
 * Inputs/Outputs: validation + sensitivity + conflict policy; returns allow/reroute/block.
 * Edge cases: hard conflicts and strict policy always block.
 */
export function decideAction(
  validation: DispatchValidationResultV9,
  sensitivity: DispatchPatternBindingV9['sensitivity'],
  conflictPolicy: DispatchPatternBindingV9['conflictPolicy']
): DispatchDecisionV9 {
  //audit Assumption: valid validation should allow normal route execution; risk: over-enforcement; invariant: valid => allow; handling: short-circuit.
  if (validation.valid) {
    return 'allow';
  }

  //audit Assumption: hard conflicts require blocking regardless of route class; risk: unsafe reroute; invariant: hard conflicts blocked; handling: immediate block.
  if (validation.hardConflict) {
    return 'block';
  }

  //audit Assumption: strict policy and sensitive routes should block unresolved conflicts; risk: accidental unsafe execution; invariant: strict/sensitive => block; handling: block.
  if (conflictPolicy === 'strict_block' || sensitivity === 'sensitive') {
    return 'block';
  }

  //audit Assumption: non-sensitive refresh policy uses reroute after conflict; risk: semantic drift; invariant: reroute target required upstream; handling: reroute.
  return 'reroute';
}
