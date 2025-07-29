// This backend logic uses OpenAI's SDK to process queries with reflective reasoning.
// If the request is flagged as `frontend: true`, it strips introspective commentary
// (e.g., "I observed", "This taught me") before returning the result to the user.
// Fully compliant with OpenAI SDK and usable in serverless or REST environments.

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function askHandler({
  query,
  mode = 'logic',
  frontend = false
}: {
  query: string;
  mode?: string;
  frontend?: boolean;
}): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o', // or gpt-3.5-turbo
    messages: [{ role: 'user', content: query }],
    temperature: 0.7,
  });

  const response = completion.choices[0]?.message?.content || '';

  return frontend ? stripReflections(response) : response;
}

// Utility: Strip reflective/self-referential language for frontend-safe output
function stripReflections(text: string): string {
  return text
    .replace(/I (observed|learned|reflect|believe|noticed|think)[^\.!\n]+[\.!\n]/gi, '')
    .replace(/This (taught|revealed|showed) me[^\.!\n]+[\.!\n]/gi, '')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}
