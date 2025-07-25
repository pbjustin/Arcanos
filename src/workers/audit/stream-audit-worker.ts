import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createServiceLogger } from '../../utils/logger';
import { streamResponse } from '../../services/stream';

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

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(domain) },
    { role: 'user', content: message }
  ];

  logger.info('Starting streamed audit', { domain });

  const { content, logPath } = await streamResponse('arcanos-v1', messages, logFilePath);

  logger.success('Audit stream completed', { log: logPath });
  return content;
}

// Allow running directly from node
if (require.main === module) {
  const [, , ...args] = process.argv;
  const message = args.join(' ') || 'Audit this message.';
  runStreamAudit({ message }).catch(err => {
    logger.error('Stream audit failed', err);
  });
}
