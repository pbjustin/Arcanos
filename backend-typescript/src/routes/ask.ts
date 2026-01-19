/**
 * Ask Route
 * Handle AI conversation requests using OpenAI
 */

import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import { saveConversation, logAuditEvent } from '../database';
import { logger } from '../logger';

const router = Router();

type ChatMessageRole = 'user' | 'assistant' | 'system';

interface ChatMessageInput {
  role: ChatMessageRole;
  content: string;
}

interface ParsedAskRequest {
  messages: ChatMessageInput[];
  userMessageForStorage: string;
  model: string;
  temperature: number;
  stream: boolean;
}

interface ParseResult<T> {
  ok: boolean;
  error?: string;
  value?: T;
}

const MAX_MESSAGE_LENGTH = 8000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_TOTAL_LENGTH = 12000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  //audit assumption: payload should be a JSON object; risk: invalid body; invariant: plain object; strategy: type guard.
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseChatMessageRole(value: unknown): ChatMessageRole | null {
  if (value === 'user' || value === 'assistant' || value === 'system') {
    //audit assumption: role is allowed; risk: invalid role; invariant: known role; strategy: return role.
    return value;
  }
  //audit assumption: role must be known; risk: schema mismatch; invariant: allowed roles only; strategy: return null.
  return null;
}

function normalizeMessageContent(rawContent: string): string {
  //audit assumption: trimming is safe; risk: accidental whitespace loss; invariant: content normalized; strategy: trim.
  return rawContent.trim();
}

function parseMessagesFromArray(messages: unknown): ParseResult<ChatMessageInput[]> {
  if (!Array.isArray(messages)) {
    //audit assumption: messages should be array; risk: wrong schema; invariant: array required; strategy: return error.
    return { ok: false, error: 'messages must be an array' };
  }

  if (messages.length === 0) {
    //audit assumption: messages must not be empty; risk: empty payload; invariant: >=1 message; strategy: return error.
    return { ok: false, error: 'messages must not be empty' };
  }

  if (messages.length > MAX_MESSAGES) {
    //audit assumption: message count should be bounded; risk: payload abuse; invariant: max message count; strategy: reject.
    return { ok: false, error: `messages exceeds max count (${MAX_MESSAGES})` };
  }

  const parsedMessages: ChatMessageInput[] = [];
  let totalLength = 0;

  for (const entry of messages) {
    if (!isPlainObject(entry)) {
      //audit assumption: message entries are objects; risk: invalid entry; invariant: object; strategy: return error.
      return { ok: false, error: 'messages entries must be objects' };
    }

    const role = parseChatMessageRole(entry.role);
    if (!role) {
      //audit assumption: role is required; risk: invalid role; invariant: allowed roles only; strategy: return error.
      return { ok: false, error: 'messages role must be user, assistant, or system' };
    }

    if (typeof entry.content !== 'string') {
      //audit assumption: content is string; risk: type mismatch; invariant: string content; strategy: return error.
      return { ok: false, error: 'messages content must be a string' };
    }

    const normalizedContent = normalizeMessageContent(entry.content);
    if (normalizedContent.length === 0) {
      //audit assumption: content should be non-empty; risk: empty content; invariant: non-empty; strategy: return error.
      return { ok: false, error: 'messages content must be non-empty' };
    }

    if (normalizedContent.length > MAX_MESSAGE_LENGTH) {
      //audit assumption: per-message length limited; risk: oversized payload; invariant: max length; strategy: return error.
      return { ok: false, error: `messages content exceeds ${MAX_MESSAGE_LENGTH} characters` };
    }

    totalLength += normalizedContent.length;
    if (totalLength > MAX_MESSAGE_TOTAL_LENGTH) {
      //audit assumption: total length bounded; risk: large payload; invariant: total length cap; strategy: return error.
      return { ok: false, error: `messages total length exceeds ${MAX_MESSAGE_TOTAL_LENGTH}` };
    }

    parsedMessages.push({ role, content: normalizedContent });
  }

  return { ok: true, value: parsedMessages };
}

function parseMessagesFromPayload(body: Record<string, unknown>): ParseResult<ChatMessageInput[]> {
  const messages = body.messages;
  if (messages !== undefined) {
    //audit assumption: messages payload provided; risk: invalid messages; invariant: parse result ok; strategy: parse array.
    return parseMessagesFromArray(messages);
  }

  const message = body.message;
  if (typeof message !== 'string') {
    //audit assumption: message is required when messages absent; risk: missing message; invariant: message present; strategy: return error.
    return { ok: false, error: 'message is required' };
  }

  const normalizedMessage = normalizeMessageContent(message);
  if (normalizedMessage.length === 0) {
    //audit assumption: message should be non-empty; risk: empty message; invariant: non-empty; strategy: return error.
    return { ok: false, error: 'message is required' };
  }

  if (normalizedMessage.length > MAX_MESSAGE_LENGTH) {
    //audit assumption: message length limited; risk: oversized payload; invariant: max length; strategy: return error.
    return { ok: false, error: 'message exceeds maximum length' };
  }

  return { ok: true, value: [{ role: 'user', content: normalizedMessage }] };
}

function extractUserMessageForStorage(messages: ChatMessageInput[]): string {
  const userMessages = messages.filter((entry) => entry.role === 'user');
  if (userMessages.length === 0) {
    //audit assumption: user message should exist; risk: missing user prompt; invariant: user message available; strategy: fallback to first.
    return messages[0].content;
  }
  //audit assumption: last user message is most relevant; risk: earlier message used; invariant: last user message chosen; strategy: select last.
  return userMessages[userMessages.length - 1].content;
}

function parseTemperature(value: unknown): ParseResult<number> {
  if (value === undefined || value === null || value === '') {
    //audit assumption: temperature optional; risk: missing value; invariant: default used; strategy: return default.
    return { ok: true, value: 0.7 };
  }

  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) {
    //audit assumption: temperature must be numeric; risk: invalid input; invariant: finite number; strategy: return error.
    return { ok: false, error: 'temperature must be a number' };
  }

  if (parsed < 0 || parsed > 2) {
    //audit assumption: temperature within range; risk: invalid parameter; invariant: 0-2 inclusive; strategy: return error.
    return { ok: false, error: 'temperature must be between 0 and 2' };
  }

  return { ok: true, value: parsed };
}

function parseModel(value: unknown): string {
  const configuredModel = process.env.OPENAI_MODEL || 'gpt-4o';
  if (typeof value === 'string' && value.trim().length > 0) {
    //audit assumption: model override allowed; risk: unsupported model; invariant: non-empty string; strategy: trim and use.
    return value.trim();
  }
  //audit assumption: default model used; risk: config missing; invariant: fallback provided; strategy: return configured default.
  return configuredModel;
}

function parseStreamFlag(value: unknown): boolean {
  //audit assumption: stream flag may be boolean or string; risk: incorrect type; invariant: boolean; strategy: normalize.
  return value === true || value === 'true';
}

function parseAskRequest(body: unknown): ParseResult<ParsedAskRequest> {
  if (!isPlainObject(body)) {
    //audit assumption: request body is JSON object; risk: invalid payload; invariant: object; strategy: return error.
    return { ok: false, error: 'request body must be an object' };
  }

  const messagesResult = parseMessagesFromPayload(body);
  if (!messagesResult.ok || !messagesResult.value) {
    //audit assumption: messages payload valid; risk: invalid messages; invariant: messages ok; strategy: return error.
    return { ok: false, error: messagesResult.error || 'invalid messages payload' };
  }

  const temperatureResult = parseTemperature(body.temperature);
  if (!temperatureResult.ok || temperatureResult.value === undefined) {
    //audit assumption: temperature valid; risk: invalid temperature; invariant: temperature ok; strategy: return error.
    return { ok: false, error: temperatureResult.error || 'invalid temperature' };
  }

  const parsedModel = parseModel(body.model);
  const parsedStream = parseStreamFlag(body.stream);
  const userMessageForStorage = extractUserMessageForStorage(messagesResult.value);

  return {
    ok: true,
    value: {
      messages: messagesResult.value,
      userMessageForStorage,
      model: parsedModel,
      temperature: temperatureResult.value,
      stream: parsedStream
    }
  };
}

function resolveCostRates() {
  const defaultInputRate = Number.parseFloat(process.env.OPENAI_INPUT_COST_PER_1M || '5');
  const defaultOutputRate = Number.parseFloat(process.env.OPENAI_OUTPUT_COST_PER_1M || '15');

  //audit assumption: cost rates are finite numbers; risk: NaN; invariant: numeric rates; strategy: fallback to defaults.
  const inputRate = Number.isFinite(defaultInputRate) ? defaultInputRate : 5;
  const outputRate = Number.isFinite(defaultOutputRate) ? defaultOutputRate : 15;

  return { inputRate, outputRate };
}

function calculateTokenCost(inputTokens: number, outputTokens: number): number {
  const { inputRate, outputRate } = resolveCostRates();
  //audit assumption: token counts are non-negative; risk: negative values; invariant: non-negative; strategy: max with zero.
  const safeInputTokens = Math.max(0, inputTokens);
  const safeOutputTokens = Math.max(0, outputTokens);
  //audit assumption: cost is linear; risk: inaccurate pricing; invariant: approximation; strategy: per-1M calculation.
  return (safeInputTokens * inputRate + safeOutputTokens * outputRate) / 1_000_000;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId || 'anonymous';
    const parsedRequest = parseAskRequest(req.body);

    if (!parsedRequest.ok || !parsedRequest.value) {
      //audit assumption: payload should be valid; risk: bad request; invariant: parsed request ok; strategy: return 400.
      return res.status(400).json({
        error: 'Bad Request',
        message: parsedRequest.error || 'Invalid request body'
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      //audit assumption: API key configured; risk: backend unusable; invariant: key set; strategy: return 500.
      logger.error('OPENAI_API_KEY is not configured');
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'OpenAI API key is not configured'
      });
    }

    // Call OpenAI API
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    if (parsedRequest.value.stream) {
      //audit assumption: streaming requested; risk: client disconnect; invariant: SSE headers set; strategy: stream with try/finally.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      let responseText = '';
      let tokens = 0;
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        const completionStream = await openai.chat.completions.create({
          model: parsedRequest.value.model,
          messages: parsedRequest.value.messages,
          temperature: parsedRequest.value.temperature,
          stream: true,
          stream_options: { include_usage: true }
        });

        for await (const chunk of completionStream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            //audit assumption: delta content is append-only; risk: order issues; invariant: concatenation; strategy: append and stream.
            responseText += delta;
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
          if (chunk.usage) {
            //audit assumption: usage may appear late; risk: missing usage; invariant: usage captured when present; strategy: update tokens.
            tokens = chunk.usage.total_tokens || 0;
            inputTokens = chunk.usage.prompt_tokens || 0;
            outputTokens = chunk.usage.completion_tokens || 0;
          }
        }

        const cost = calculateTokenCost(inputTokens, outputTokens);

        await saveConversation(
          userId,
          parsedRequest.value.userMessageForStorage,
          responseText,
          tokens,
          cost
        );
        await logAuditEvent(
          userId,
          'conversation',
          { tokens, cost, model: parsedRequest.value.model, streamed: true },
          req.ip,
          req.get('user-agent')
        );
        logger.info('Conversation completed', {
          userId,
          tokens,
          cost,
          model: parsedRequest.value.model,
          streamed: true
        });
        res.write('data: [DONE]\n\n');
      } catch (error) {
        //audit assumption: streaming can fail; risk: partial response; invariant: error surfaced; strategy: log and emit error event.
        logger.error('Failed to process streamed conversation', { error });
        res.write(`data: ${JSON.stringify({ error: 'Internal Server Error' })}\n\n`);
      } finally {
        res.end();
      }

      return;
    }

    const completion = await openai.chat.completions.create({
      model: parsedRequest.value.model,
      messages: parsedRequest.value.messages,
      temperature: parsedRequest.value.temperature
    });

    const response = completion.choices[0]?.message?.content || '';
    const tokens = completion.usage?.total_tokens || 0;

    const inputTokens = completion.usage?.prompt_tokens || 0;
    const outputTokens = completion.usage?.completion_tokens || 0;
    const cost = calculateTokenCost(inputTokens, outputTokens);

    await saveConversation(
      userId,
      parsedRequest.value.userMessageForStorage,
      response,
      tokens,
      cost
    );
    await logAuditEvent(
      userId,
      'conversation',
      { tokens, cost, model: parsedRequest.value.model },
      req.ip,
      req.get('user-agent')
    );

    logger.info('Conversation completed', { userId, tokens, cost, model: parsedRequest.value.model });

    return res.json({
      success: true,
      response,
      tokens,
      cost,
      model: parsedRequest.value.model
    });
  } catch (error) {
    //audit assumption: unexpected errors handled; risk: crash; invariant: 500 returned; strategy: log and return error.
    logger.error('Failed to process conversation', { error });
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process conversation'
    });
  }
});

export default router;
