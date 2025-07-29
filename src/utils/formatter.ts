/**
 * Formatter utilities for ARCANOS
 * Provides text formatting functions for guides and other content
 */

/**
 * Format guide chunks into readable text
 * Joins sections with appropriate spacing and formatting
 * @param sections - Array of guide sections
 * @param separator - Optional separator between sections (default: double newline)
 * @returns Formatted guide text
 */
export const formatGuideChunks = (sections: string[], separator: string = '\n\n'): string => {
  if (!Array.isArray(sections)) {
    return '';
  }
  
  return sections
    .filter(section => section && typeof section === 'string')
    .map(section => section.trim())
    .filter(section => section.length > 0)
    .join(separator);
};

/**
 * Format guide sections with headers
 * @param sections - Array of guide sections with optional headers
 * @param includeNumbers - Whether to include section numbers (default: false)
 * @returns Formatted guide text with section headers
 */
export const formatGuideSections = (
  sections: Array<string | { title?: string; content: string }>, 
  includeNumbers: boolean = false
): string => {
  if (!Array.isArray(sections)) {
    return '';
  }

  return sections
    .map((section, index) => {
      if (typeof section === 'string') {
        const prefix = includeNumbers ? `${index + 1}. ` : '';
        return `${prefix}${section.trim()}`;
      } else if (section && typeof section === 'object' && section.content) {
        const number = includeNumbers ? `${index + 1}. ` : '';
        const title = section.title ? `${number}${section.title}\n` : '';
        return `${title}${section.content.trim()}`;
      }
      return '';
    })
    .filter(section => section.length > 0)
    .join('\n\n');
};