/**
 * Utility helpers for JSON processing across the project
 */

/**
 * Remove markdown code fences around JSON strings.
 * This is useful when models wrap JSON output in ```json code blocks.
 */
export function sanitizeJsonString(input: string): string {
  return input.replace(/```json|```/g, '').trim();
}
