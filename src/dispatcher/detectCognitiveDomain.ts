import type { CognitiveDomain } from '../types/cognitiveDomain.js';

export interface DomainDetectionResult {
  domain: CognitiveDomain;
  confidence: number;
}

export function detectCognitiveDomain(prompt: string): DomainDetectionResult {
  const p = prompt.toLowerCase();

  // Creative: writing fiction, stories, poems, etc.
  // Handles optional articles: "write a story", "write story", "write an epic"
  if (/\bwrite\b(?:\s+(?:a|an))?\s+(?:story|scene|dialogue|novel|poem|lyrics)\b/.test(p)) {
    return { domain: 'creative', confidence: 0.95 };
  }

  // Code: programming, refactoring, implementations
  if (/\b(?:refactor|typescript|javascript|python|implement|write a function|fix the code|code review)\b/.test(p)) {
    return { domain: 'code', confidence: 0.9 };
  }

  // Diagnostic: debugging, troubleshooting, analysis
  if (/\b(?:diagnose|debug|why is|error|review architecture|audit|stack trace|exception)\b/.test(p)) {
    return { domain: 'diagnostic', confidence: 0.9 };
  }

  // Execution: commands and file operations
  // Uses flexible boundaries to match patterns like "(execute the script)"
  if (/(^|[^\w])(?:execute|run|delete file|create file|modify file|deploy|restart)(?=$|[^\w])/.test(p)) {
    return { domain: 'execution', confidence: 0.85 };
  }

  // Default: natural language queries
  return { domain: 'natural', confidence: 0.6 };
}
