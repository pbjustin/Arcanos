import OpenAI from 'openai';

export interface CodeInterpreterResult {
  content: string;
  files?: any[];
}

export class CodeInterpreterService {
  private client: OpenAI;
  private model: string;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required');
    }

    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.model = process.env.CODE_INTERPRETER_MODEL || 'gpt-4o';
  }

  async run(prompt: string): Promise<CodeInterpreterResult> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'code_interpreter' }] as any,
    });

    const message: any = completion.choices[0].message;
    return {
      content: message.content || '',
      files: (message.files as any[]) || [],
    };
  }
}

export const codeInterpreterService = new CodeInterpreterService();
