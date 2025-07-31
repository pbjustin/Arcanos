import { getUnifiedOpenAI } from './unified-openai';

export interface CodeInterpreterResult {
  content: string;
  files?: any[];
}

export class CodeInterpreterService {
  private unifiedOpenAI: ReturnType<typeof getUnifiedOpenAI>;
  private model: string;

  constructor() {
    this.unifiedOpenAI = getUnifiedOpenAI();
    this.model = process.env.CODE_INTERPRETER_MODEL || 'gpt-4o';
  }

  async run(prompt: string): Promise<CodeInterpreterResult> {
    const tools = [{ type: 'code_interpreter' as const }];
    
    const response = await this.unifiedOpenAI.chat([
      { role: 'user', content: prompt }
    ], {
      model: this.model,
      tools: tools as any
    });

    return {
      content: response.content || '',
      files: response.toolCalls || [],
    };
  }
}

export const codeInterpreterService = new CodeInterpreterService();
