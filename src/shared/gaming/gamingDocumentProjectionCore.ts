import { filterGamingDocumentInstructions } from "@services/gamingDocumentExtraction.js";
import type { GamingEvidenceUnit } from './gamingEvidenceUnits.js';

/** Project acquired prose under the caller's selected-document character bound. */
export function projectGamingDocumentText(input: {
  acquiredText: string;
  maxChars: number;
  selectedTextLength: number;
  evidenceUnits?: readonly GamingEvidenceUnit[];
}): { text: string; cleanedTextLength: number; truncated: boolean; instructionFiltered: boolean } {
  const boundedText = input.acquiredText.slice(0, input.maxChars);
  const filteredText = filterGamingDocumentInstructions(boundedText);
  let text = filteredText.slice(0, input.maxChars);
  // Raw HTML capture may be shorter than its extracted prose. Only selected
  // prose bounds and normalization expansion indicate partial document text.
  let truncated = input.selectedTextLength > boundedText.length
    || input.acquiredText.length > input.maxChars || filteredText.length > input.maxChars;
  for (const unit of input.evidenceUnits ?? []) {
    const separator = text ? '\n\n' : '';
    if (text.length + separator.length + unit.text.length > input.maxChars) {
      truncated = true;
      continue;
    }
    text += separator + unit.text;
  }
  return {
    text,
    cleanedTextLength: text.length,
    truncated,
    instructionFiltered: filteredText.length < boundedText.normalize("NFKC").replace(/\s+/g, " ").trim().length
  };
}
