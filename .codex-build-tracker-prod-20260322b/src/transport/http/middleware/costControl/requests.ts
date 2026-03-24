import type { Request, Response } from 'express';
import type { OpenAIRequestPayload } from './types.js';

export function resolvePrompt(req: Request): string | null {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  //audit Assumption: prompt is required for OpenAI calls; risk: empty prompt; invariant: non-empty prompt for downstream; handling: return null when invalid.
  return prompt.length > 0 ? prompt : null;
}

export function resolvePayload(req: Request, prompt: string): OpenAIRequestPayload {
  const payload: OpenAIRequestPayload = {
    prompt,
    model: typeof req.body?.model === 'string' ? req.body.model : undefined,
    maxTokens: typeof req.body?.maxTokens === 'number' ? req.body.maxTokens : undefined,
    metadata: { route: req.path }
  };
  //audit Assumption: request body fields are safe to map; risk: incorrect types; invariant: payload fields are optional; handling: guard types.
  return payload;
}

export function createResponseGuard(res: Response) {
  let responded = false;
  return {
    sendJson: (status: number, payload: unknown) => {
      //audit Assumption: response can be sent once; risk: double send; invariant: response is sent at most once; handling: guard with flag and headersSent.
      if (responded || res.headersSent) return;
      responded = true;
      res.status(status).json(payload);
    },
    sendOk: (payload: unknown) => {
      //audit Assumption: success responses are JSON; risk: incorrect format; invariant: JSON response for API; handling: delegate to sendJson.
      if (responded || res.headersSent) return;
      responded = true;
      res.json(payload);
    }
  };
}
