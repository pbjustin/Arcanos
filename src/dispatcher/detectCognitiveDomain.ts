import type { CognitiveDomain } from '../types/cognitiveDomain.js';

export interface DomainDetectionResult {
  domain: CognitiveDomain;
  confidence: number;
}

export function detectCognitiveDomain(prompt: string): DomainDetectionResult {
  const p = prompt.toLowerCase();

  if (/write (a )?(story|scene|dialogue|novel|poem|lyrics)/.test(p)) {
    return { domain: 'creative', confidence: 0.95 };
  }

  if (/\b(refactor|typescript|javascript|python|implement|write a function|fix the code|code review)\b/.test(p)) {
    return { domain: 'code', confidence: 0.9 };
  }

  if (/\b(diagnose|debug|why is|error|review architecture|audit|stack trace|exception)\b/.test(p)) {
    return { domain: 'diagnostic', confidence: 0.9 };
  }

  if (/\b(execute|run|delete file|create file|modify file|deploy|restart)\b/.test(p)) {
    return { domain: 'execution', confidence: 0.85 };
  }

  return { domain: 'natural', confidence: 0.6 };
}
