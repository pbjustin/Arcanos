export type MemoryInspectionArtifact =
  | 'raw_memory_rows'
  | 'audit_log_entries'
  | 'snapshot_history'
  | 'session_event_hooks';

export interface ParsedMemoryInspectionRequest {
  requestedArtifacts: MemoryInspectionArtifact[];
  unsupportedArtifacts: MemoryInspectionArtifact[];
}

const RAW_MEMORY_ROWS_PATTERN =
  /\b(?:full\s+raw\s+memory\s+table|raw\s+memory\s+table|raw\s+memory|raw\s+table|memory\s+table|exact\s+raw\s+memory|raw\s+memory\s+objects?|stored\s+objects?|raw\s+pattern\s+json|raw\s+json)\b/i;
const AUDIT_LOG_PATTERN = /\baudit\s+log(?:\s+entries?)?\b|\baudit\s+events?\b/i;
const SNAPSHOT_HISTORY_PATTERN = /\bsnapshot\s+history\b|\brollback\s+snapshot\b/i;
const SESSION_EVENT_HOOKS_PATTERN = /\bsession\s+event\s+hooks?\b|\bevent\s+hooks?\b/i;

const SUPPORTED_MEMORY_INSPECTION_ARTIFACTS = new Set<MemoryInspectionArtifact>(['raw_memory_rows']);

/**
 * Parse backend-memory inspection prompts into deterministic artifact requests.
 * Inputs/outputs: raw user prompt -> requested inspection artifacts or null.
 * Edge cases: duplicate cues are deduplicated and unsupported artifacts are surfaced explicitly.
 */
export function parseMemoryInspectionRequest(rawInput: string): ParsedMemoryInspectionRequest | null {
  const requestedArtifacts = new Set<MemoryInspectionArtifact>();

  if (RAW_MEMORY_ROWS_PATTERN.test(rawInput)) {
    requestedArtifacts.add('raw_memory_rows');
  }

  if (AUDIT_LOG_PATTERN.test(rawInput)) {
    requestedArtifacts.add('audit_log_entries');
  }

  if (SNAPSHOT_HISTORY_PATTERN.test(rawInput)) {
    requestedArtifacts.add('snapshot_history');
  }

  if (SESSION_EVENT_HOOKS_PATTERN.test(rawInput)) {
    requestedArtifacts.add('session_event_hooks');
  }

  //audit Assumption: only explicit inspection cues should trigger deterministic backend inspection mode; failure risk: ordinary memory lookups get over-classified as raw inspection; expected invariant: null is returned when no inspection artifact was requested; handling strategy: require at least one artifact cue.
  if (requestedArtifacts.size === 0) {
    return null;
  }

  const requestedArtifactList = Array.from(requestedArtifacts);
  const unsupportedArtifacts = requestedArtifactList.filter(
    (artifact) => !SUPPORTED_MEMORY_INSPECTION_ARTIFACTS.has(artifact)
  );

  return {
    requestedArtifacts: requestedArtifactList,
    unsupportedArtifacts,
  };
}

/**
 * Determine whether a prompt is asking for raw backend memory inspection.
 * Inputs/outputs: raw prompt -> boolean inspection cue.
 * Edge cases: returns false for blank prompts and non-inspection memory requests.
 */
export function isMemoryInspectionPrompt(rawInput: string): boolean {
  return parseMemoryInspectionRequest(rawInput) !== null;
}

/**
 * Build a deterministic note for unsupported backend inspection artifacts.
 * Inputs/outputs: unsupported artifact list -> operator-facing note or null.
 * Edge cases: empty lists return null so callers can omit the note cleanly.
 */
export function buildUnsupportedMemoryInspectionNote(
  unsupportedArtifacts: MemoryInspectionArtifact[]
): string | null {
  if (unsupportedArtifacts.length === 0) {
    return null;
  }

  const labels = unsupportedArtifacts.map((artifact) => {
    switch (artifact) {
      case 'audit_log_entries':
        return 'audit log entries';
      case 'snapshot_history':
        return 'snapshot history';
      case 'session_event_hooks':
        return 'session event hooks';
      default:
        return artifact;
    }
  });

  return `${labels.join(', ')} are not exposed by this route, so no claims about them were generated.`;
}

/**
 * Build a deterministic guard message for unsupported backend-state inspection prompts.
 * Inputs/outputs: optional session id plus unsupported artifacts -> grounded refusal text.
 * Edge cases: session id is optional so callers without scoped context still get a valid response.
 */
export function buildMemoryInspectionGuardMessage(params: {
  sessionId?: string | null;
  unsupportedArtifacts: MemoryInspectionArtifact[];
}): string {
  const scopedSessionText =
    typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
      ? ` for session ${params.sessionId.trim()}`
      : '';
  const unsupportedNote = buildUnsupportedMemoryInspectionNote(params.unsupportedArtifacts);

  //audit Assumption: raw inspection prompts must fail closed when the route cannot ground backend-state claims; failure risk: tutor/model layers fabricate audit state, snapshot history, or hidden hooks; expected invariant: the response names only exact persisted memory access and explicitly refuses unsupported artifacts; handling strategy: return a deterministic guard message.
  return unsupportedNote
    ? `This route can only return exact persisted memory rows${scopedSessionText}. ${unsupportedNote}`
    : `This route can only return exact persisted memory rows${scopedSessionText}.`;
}
