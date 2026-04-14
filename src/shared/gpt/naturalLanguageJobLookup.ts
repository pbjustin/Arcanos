const JOB_ROUTE_LOOKUP_RE = /\/jobs\/(?<jobId>[^/\s?#]+)(?:\/(?<routeKind>result))?/i;
const JOB_TEXT_ID_RE = /\bjob(?:\s+id)?\s*(?::|#|=|\bis\b)?\s*(?<jobId>[A-Za-z0-9][A-Za-z0-9._:-]{2,})\b/i;
const JOB_LOOKUP_VERB_RE = /\b(check|fetch|get|inspect|lookup|poll|pull|read|retrieve|show)\b/i;
const JOB_RESULT_CUE_RE = /\b(answer|completion|output|response|result)\b/i;
const JOB_STATUS_CUE_RE = /\b(poll|progress|state|status)\b/i;
const JOB_CUE_RE = /\bjobs?\b|\/jobs\//i;
const JOB_LOOKUP_PHRASE_RE =
  /\b(?:answer|completion|output|response|result|poll|progress|state|status)\b\s+(?:for|of)\s+job(?:\s+id)?\b/i;
const JOB_LOOKUP_QUESTION_RE =
  /\bwhat(?:'s|\s+is)?\b[^.?!]{0,80}\b(?:answer|completion|output|response|result|poll|progress|state|status)\b[^.?!]{0,80}\bjob(?:\s+id)?\b/i;
const RESERVED_JOB_ID_TOKENS = new Set([
  'a',
  'an',
  'answer',
  'for',
  'it',
  'job',
  'jobs',
  'of',
  'output',
  'please',
  'poll',
  'progress',
  'response',
  'result',
  'state',
  'status',
  'that',
  'the',
  'this',
  'to'
]);

export type NaturalLanguageJobLookupIntent =
  | {
      ok: true;
      kind: 'result' | 'status';
      jobId: string;
      source: 'jobs_route' | 'natural_language';
    }
  | {
      ok: false;
      kind: 'result' | 'status';
      error: 'missing_job_id';
      source: 'jobs_route' | 'natural_language';
    };

function resolveLookupKind(message: string, routeKind?: string | null): 'result' | 'status' {
  if (routeKind?.trim().toLowerCase() === 'result') {
    return 'result';
  }

  return JOB_RESULT_CUE_RE.test(message) ? 'result' : 'status';
}

function normalizeLookupJobId(rawJobId: string | undefined): string | null {
  const normalizedJobId = rawJobId?.trim().replace(/[.,:;)\]}>\"']+$/g, '') ?? '';
  if (!normalizedJobId) {
    return null;
  }

  if (RESERVED_JOB_ID_TOKENS.has(normalizedJobId.toLowerCase())) {
    return null;
  }

  return normalizedJobId;
}

export function parseNaturalLanguageJobLookup(promptText: string | null): NaturalLanguageJobLookupIntent | null {
  const normalizedPrompt = promptText?.trim() ?? '';
  if (!normalizedPrompt) {
    return null;
  }

  const routeMatch = normalizedPrompt.match(JOB_ROUTE_LOOKUP_RE);
  if (routeMatch?.groups?.jobId) {
    const kind = resolveLookupKind(normalizedPrompt, routeMatch.groups.routeKind);
    const jobId = normalizeLookupJobId(routeMatch.groups.jobId);
    return jobId
      ? { ok: true, kind, jobId, source: 'jobs_route' }
      : { ok: false, kind, error: 'missing_job_id', source: 'jobs_route' };
  }

  const hasJobCue = JOB_CUE_RE.test(normalizedPrompt);
  const hasLookupVerb = JOB_LOOKUP_VERB_RE.test(normalizedPrompt);
  const hasResultCue = JOB_RESULT_CUE_RE.test(normalizedPrompt);
  const hasStatusCue = JOB_STATUS_CUE_RE.test(normalizedPrompt);
  const naturalLanguageJobId = normalizeLookupJobId(normalizedPrompt.match(JOB_TEXT_ID_RE)?.groups?.jobId);
  const hasQuestionStyleLookup =
    naturalLanguageJobId !== null &&
    (JOB_LOOKUP_PHRASE_RE.test(normalizedPrompt) || JOB_LOOKUP_QUESTION_RE.test(normalizedPrompt));
  const explicitLookupRequest =
    hasJobCue &&
    (hasLookupVerb || normalizedPrompt.toLowerCase().startsWith('job ') || hasQuestionStyleLookup) &&
    (hasResultCue || hasStatusCue);

  if (!explicitLookupRequest) {
    return null;
  }

  const kind: 'result' | 'status' = hasResultCue ? 'result' : 'status';
  const jobId = naturalLanguageJobId;

  return jobId
    ? { ok: true, kind, jobId, source: 'natural_language' }
    : { ok: false, kind, error: 'missing_job_id', source: 'natural_language' };
}
