import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import fs from 'fs';
import path from 'path';
import { createServiceLogger } from '../../utils/logger';

const logger = createServiceLogger('StreamAuditWorker');

export interface StreamAuditRequest {
  message: string;
  domain?: string;
  logFilePath?: string;
}

function buildSystemPrompt(domain: string): string {
  return `You are ARCANOS in AUDIT mode. Validate content for domain: ${domain}.`;
}

/**
 * Run an audit using OpenAI streaming. Tokens are streamed to stdout and a log file.
 */
export async function runStreamAudit({ message, domain = 'general', logFilePath }: StreamAuditRequest): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required');
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const logDir = path.join(process.cwd(), 'storage', 'audit-logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const finalLogPath = logFilePath || path.join(logDir, `audit_${Date.now()}.log`);
  const fileStream = fs.createWriteStream(finalLogPath, { flags: 'a' });

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(domain) },
    { role: 'user', content: message }
  ];

  logger.info('Starting streamed audit', { domain });

  const stream = await openai.chat.completions.create({
    model: 'arcanos-v1',
    messages,
    stream: true
  });

  let fullResponse = '';
  for await (const chunk of stream) {
    const token = chunk.choices?.[0]?.delta?.content || '';
    if (token) {
      process.stdout.write(token);
      fileStream.write(token);
      fullResponse += token;
    }
  }

  fileStream.end();
  logger.success('Audit stream completed', { log: finalLogPath });
  return fullResponse;
}

// Allow running directly from node
if (require.main === module) {
  const [, , ...args] = process.argv;
  const message = args.join(' ') || 'Audit this message.';
  runStreamAudit({ message }).catch(err => {
    logger.error('Stream audit failed', err);
  });
}
