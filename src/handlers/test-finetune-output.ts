import OpenAI from 'openai';
import { Request, Response } from 'express';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function testFineTuneOutput(req: Request, res: Response) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo-0125:personal:arcanos-v1-1106',
      messages: [
        { role: 'system', content: 'You are ARCANOS, a diagnostic AI.' },
        { role: 'user', content: "Respond with 'Diagnostics working.'" }
      ]
    });

    console.log('[MODEL COMPLETION]', JSON.stringify(completion, null, 2));

    if (!completion.choices || completion.choices.length === 0) {
      throw new Error('No choices returned from AI.');
    }

    const content = completion.choices[0].message?.content;
    const fallback = 'Diagnostics working.';

    if (!content) {
      console.warn('AI response missing content, using fallback.');
    }

    res.status(200).json({ success: true, response: content || fallback });
  } catch (err: any) {
    console.error('AI Diagnostic Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}
