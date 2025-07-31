import { getUnifiedOpenAI } from '../../services/unified-openai';
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
  return `You are ARCANOS in AUDIT mode. Validate content for domain: ${domain}.
  
Provide comprehensive audit analysis including:
- Content validation
- Security considerations  
- Compliance assessment
- Risk evaluation
- Recommendations for improvement`;
}

/**
 * Run an audit using the core AI service with streaming, retry logic, and comprehensive logging
 */
export async function runStreamAudit({ message, domain = 'general', logFilePath }: StreamAuditRequest): Promise<string> {
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

  logger.info('Starting streamed audit with retry logic', { domain, logPath: finalLogPath });

  try {
    let fullResponse = '';
    const unifiedOpenAI = getUnifiedOpenAI();
    const result = await unifiedOpenAI.chatStream(
      messages.map(msg => ({
        role: msg.role as any,
        content: msg.content as string,
      })),
      (token: string, isComplete: boolean) => {
        if (!isComplete) {
          process.stdout.write(token);
          fileStream.write(token);
          fullResponse += token;
        }
      },
      {
        maxTokens: 2000,
        temperature: 0.4,
      }
    );

    fileStream.end();

    if (!result.success) {
      logger.error('Audit stream failed with fallback', { 
        domain, 
        error: result.error,
        logPath: finalLogPath 
      });
      throw new Error(`Audit failed: ${result.error}`);
    }

    logger.success('Audit stream completed successfully', { 
      domain,
      responseLength: fullResponse.length, 
      logPath: finalLogPath 
    });
    
    return fullResponse;
    
  } catch (error: any) {
    fileStream.end();
    logger.error('Audit stream execution failed', error, { domain, logPath: finalLogPath });
    throw error;
  }
}

// Allow running directly from node
if (require.main === module) {
  const [, , ...args] = process.argv;
  const message = args.join(' ') || 'Audit this message.';
  runStreamAudit({ message }).catch(err => {
    logger.error('Stream audit failed', err);
  });
}
