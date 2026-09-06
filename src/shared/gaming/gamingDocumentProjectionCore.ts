import { filterGamingDocumentInstructions } from "@services/gamingDocumentExtraction.js";

/** Project acquired prose under the caller's selected-document character bound. */
export function projectGamingDocumentText(input: {
  acquiredText: string;
  maxChars: number;
  selectedTextLength: number;
}): { text: string; cleanedTextLength: number; truncated: boolean; instructionFiltered: boolean } {
  const boundedText = input.acquiredText.slice(0, input.maxChars);
  const filteredText = filterGamingDocumentInstructions(boundedText);
  const text = filteredText.slice(0, input.maxChars);
  // Raw HTML capture may be shorter than its extracted prose. Only selected
  // prose bounds and normalization expansion indicate partial document text.
  const truncated = input.selectedTextLength > boundedText.length
    || input.acquiredText.length > input.maxChars || filteredText.length > input.maxChars;
  return {
    text,
    cleanedTextLength: text.length,
    truncated,
    instructionFiltered: filteredText.length < boundedText.normalize("NFKC").replace(/\s+/g, " ").trim().length
  };
}
