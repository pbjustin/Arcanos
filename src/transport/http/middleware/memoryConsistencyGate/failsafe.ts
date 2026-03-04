import type { DispatchPatternBindingV9 } from '@shared/types/dispatchV9.js';

export function runFailsafeChecks(
  binding: DispatchPatternBindingV9 | null,
  snapshotLoaded: boolean,
  memoryVersion: string,
  rerouteTarget?: string,
  isRegisteredTarget?: boolean
): { ok: boolean; reason?: string } {
  //audit Assumption: binding is required for policy-safe reroute decisions; risk: undefined routing policy; invariant: binding present; handling: fail-fast.
  if (!binding) {
    return { ok: false, reason: 'binding_missing' };
  }
  //audit Assumption: reroute requires loaded snapshot context; risk: stale/unknown state; invariant: snapshot loaded; handling: fail-fast.
  if (!snapshotLoaded) {
    return { ok: false, reason: 'snapshot_missing' };
  }
  //audit Assumption: memory version must be parseable for traceability; risk: unverifiable state timeline; invariant: valid ISO; handling: fail-fast.
  if (Number.isNaN(Date.parse(memoryVersion))) {
    return { ok: false, reason: 'memory_version_invalid' };
  }
  //audit Assumption: reroute target must correspond to a registered binding path; risk: open redirect-like path mutation; invariant: target is registered; handling: fail-fast.
  if (!rerouteTarget || !isRegisteredTarget) {
    return { ok: false, reason: 'reroute_target_unregistered' };
  }
  return { ok: true };
}
