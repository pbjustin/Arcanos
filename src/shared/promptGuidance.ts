export const OPENAI_PROMPT_GUIDANCE_SECTIONS = [
  'Role',
  'Personality/collaboration style',
  'Goal',
  'Success criteria',
  'Constraints',
  'Tool rules',
  'Retrieval or evidence rules',
  'Validation rules',
  'Output contract',
  'Stop rules'
] as const;

export type OpenAIPromptGuidanceSection = typeof OPENAI_PROMPT_GUIDANCE_SECTIONS[number];

export type PromptGuidanceSectionValue = string | readonly string[];

export type PromptGuidanceSections = Partial<Record<OpenAIPromptGuidanceSection, PromptGuidanceSectionValue>>;

function normalizeSectionValue(value: PromptGuidanceSectionValue): string {
  if (typeof value !== 'string') {
    return value
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => (/^[-*]\s/.test(item) ? item : `- ${item}`))
      .join('\n');
  }

  return value.trim();
}

export function findMissingPromptGuidanceSections(
  prompt: string,
  requiredSections: readonly OpenAIPromptGuidanceSection[] = OPENAI_PROMPT_GUIDANCE_SECTIONS
): OpenAIPromptGuidanceSection[] {
  return requiredSections.filter(section => !new RegExp(`(^|\\n)${section}:`, 'i').test(prompt));
}

export function renderPromptGuidanceSections(
  sections: PromptGuidanceSections,
  options: {
    header?: string;
    requiredSections?: readonly OpenAIPromptGuidanceSection[];
  } = {}
): string {
  const requiredSections = options.requiredSections ?? OPENAI_PROMPT_GUIDANCE_SECTIONS;
  const missing = requiredSections.filter(section => {
    const value = sections[section];
    return value === undefined || normalizeSectionValue(value).length === 0;
  });

  if (missing.length > 0) {
    throw new Error(`Prompt guidance sections missing: ${missing.join(', ')}`);
  }

  const renderedSections = OPENAI_PROMPT_GUIDANCE_SECTIONS
    .map(section => {
      const value = sections[section];
      if (value === undefined) {
        return null;
      }

      const normalized = normalizeSectionValue(value);
      return normalized ? `${section}:\n${normalized}` : null;
    })
    .filter((section): section is string => Boolean(section));

  return [
    options.header ?? '[OPENAI_PROMPT_GUIDANCE]',
    ...renderedSections
  ].join('\n\n');
}
