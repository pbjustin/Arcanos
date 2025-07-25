import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import fs from 'fs';
import path from 'path';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('StreamService');

/**
 * Stream a ChatGPT response and log tokens to stdout and a file.
 * Returns the full concatenated response string.
 */
export async function streamResponse(
  model: string,
  messages: ChatCompletionMessageParam[],
  logFilePath?: string
): Promise<{ content: string; logPath: string }> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required');
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const logDir = path.join(process.cwd(), 'storage', 'audit-logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logPath = logFilePath || path.join(logDir, `stream_${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  logger.info('Starting streaming response', { model });

  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true
  });

  let content = '';
  for await (const chunk of stream) {
    const token = chunk.choices?.[0]?.delta?.content || '';
    if (token) {
      process.stdout.write(token);
      logStream.write(token);
      content += token;
    }
  }

  logStream.end();
  logger.success('Streaming complete', { logPath });
  return { content, logPath };
}
