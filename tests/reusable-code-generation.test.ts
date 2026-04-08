import { describe, expect, it, jest } from '@jest/globals';

import {
  generateReusableCodeSnippets,
  parseReusableCodeResponse,
} from '../src/services/reusableCodeGeneration.ts';

describe('reusable code generation', () => {
  it('parses reusable snippets through the shared structured response helper', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-4.1-mini',
      output_text: JSON.stringify({
        snippets: [
          {
            name: 'asyncHandler',
            description: 'Async express wrapper',
            language: 'typescript',
            code: 'export const asyncHandler = () => {};',
          },
        ],
      }),
      output: [],
    });

    const result = await generateReusableCodeSnippets(
      { responses: { create } } as any,
      { target: 'asyncHandler', includeDocs: true, language: 'typescript' }
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.model).toBe('gpt-4.1-mini');
    expect(result.snippets).toEqual([
      {
        name: 'asyncHandler',
        description: 'Async express wrapper',
        language: 'typescript',
        code: 'export const asyncHandler = () => {};',
      },
    ]);
  });

  it('keeps explicit schema parsing for raw JSON helper usage', () => {
    const parsed = parseReusableCodeResponse(
      '{"snippets":[{"name":"idGenerator","description":"IDs","language":"typescript","code":"export const id=() => 1;"}]}'
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('idGenerator');
  });
});
