import express, { Request, Response } from 'express';
import OpenAI from 'openai';

const router = express.Router();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Models
const ARC_V2 = 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote';
const ARC_V2_FALLBACK = 'REDACTED_FINE_TUNED_MODEL_ID';
const GPT5 = 'gpt-5';
const GPT35_SUBAGENT = 'gpt-3.5-turbo-0125';

router.post('/arcanos-pipeline', async (req: Request, res: Response) => {
  const { messages } = req.body as { messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] };

  try {
    // Step 1: First pass through ARCANOS fine-tuned model
    const arcFirst = await client.chat.completions.create({
      model: ARC_V2,
      messages
    });
    const arcFirstOutput = arcFirst.choices[0].message;

    // Step 2: GPT-3.5 sub agent processes ARCANOS output
    const subAgentResp = await client.chat.completions.create({
      model: GPT35_SUBAGENT,
      messages: [
        { role: 'system', content: 'You are a supportive sub-agent for ARCANOS. Refine or validate the prior response.' },
        { role: 'assistant', content: arcFirstOutput.content || '' }
      ]
    });
    const subAgentOutput = subAgentResp.choices[0].message;

    // Step 3: Delegate to GPT-5 for higher-level reasoning
    const gpt5Response = await client.chat.completions.create({
      model: GPT5,
      messages: [
        { role: 'system', content: 'You are the reasoning overseer for ARCANOS.' },
        { role: 'assistant', content: arcFirstOutput.content || '' },
        { role: 'assistant', content: subAgentOutput.content || '' }
      ]
    });
    const gpt5Reasoning = gpt5Response.choices[0].message;

    // Step 4: Re-ingest GPT-5 reasoning back into ARCANOS fine-tune
    const arcFinal = await client.chat.completions.create({
      model: ARC_V2,
      messages: [
        ...messages,
        { role: 'assistant', content: arcFirstOutput.content || '' },
        { role: 'assistant', content: subAgentOutput.content || '' },
        { role: 'assistant', content: gpt5Reasoning.content || '' }
      ]
    });
    const finalOutput = arcFinal.choices[0].message;

    res.json({
      result: finalOutput,
      stages: {
        arcFirst: arcFirstOutput,
        subAgent: subAgentOutput,
        gpt5Reasoning
      }
    });
  } catch (err) {
    console.error('Pipeline error:', err);
    try {
      const fallback = await client.chat.completions.create({
        model: ARC_V2_FALLBACK,
        messages
      });
      res.json({ result: fallback.choices[0].message, fallback: true });
    } catch (fallbackErr: any) {
      res.status(500).json({ error: 'Pipeline failed', details: fallbackErr.message });
    }
  }
});

export default router;
