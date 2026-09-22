import input from '../schemas/v1/tools/arcanos-tutor.input.schema.json' with { type: 'json' };
import output from '../schemas/v1/tools/arcanos-tutor.output.schema.json' with { type: 'json' };

/** Public pilot schemas; this tool is not a daemon command or operator capability. */
export const chatGptTutorInputSchema = input;
export const chatGptTutorOutputSchema = output;
export interface ChatGptTutorInput { prompt: string }
export interface ChatGptTutorOutput {
  answer: string;
  metadata: {
    module: 'ARCANOS:TUTOR';
    memory: 'unavailable';
    execution: 'synchronous';
    generation: 'model' | 'mock' | 'shortcut';
  };
}
