/** Server-owned extraction facts. These are source assertions, never authority or freshness attestations. */
export const GAMING_EVIDENCE_UNIT_POLICY_VERSION = 'gaming-evidence-units/v1';

export interface GamingEvidenceUnit {
  id: string;
  kind: 'paragraph' | 'table_row' | 'list_item' | 'definition' | 'structured_record';
  /** Deterministic readable serialization, independent of the question. */
  text: string;
  fields: Array<{ label: string; value: string }>;
  context: {
    scope: string;
    heading?: string;
    caption?: string;
    qualifiers?: string[];
    attribution?: string;
  };
  provenance: {
    sourceUrl: string;
    strategy: 'html_table' | 'html_list' | 'html_definition' | 'json_ld' | 'application_json' | 'prose';
    policyVersion: string;
    locator: string;
    representation: 'html_dom' | 'json_pointer' | 'normalized_text';
    /** JSON assertions have no established matching visible content. */
    jsonOnly?: boolean;
  };
  integrity: { status: 'complete' | 'partial' | 'ambiguous'; reasons: string[] };
}

export interface GamingEvidenceExtractionResult {
  units: GamingEvidenceUnit[];
  attempts: string[];
  subreasons: string[];
  truncated: boolean;
  inputBytes: number;
  outputChars: number;
}

export interface GamingEvidenceExtractionInput {
  body: string;
  contentType: string;
  sourceUrl: string;
  /** Production protected acquisition rejects partial transfers; fixtures/adapters must state partial input. */
  transportTruncated?: boolean;
  deadlineAt?: number;
}

/** Authenticated operator diagnostics contain counts/codes only, never source content or URLs. */
export interface GamingStructureDiagnostics {
  policyVersion: string;
  strategies: string[];
  contentType: string;
  receivedBytes?: number;
  acceptedBytes: number;
  rawChars: number;
  extractedChars: number;
  unitKinds: string[];
  selectedUnits: number;
  completeUnits: number;
  partialUnits: number;
  ambiguousUnits: number;
  truncationStages: string[];
  subreasons: string[];
  elapsedMs: number;
  budgetOutcome: 'within_budget' | 'exhausted';
}
