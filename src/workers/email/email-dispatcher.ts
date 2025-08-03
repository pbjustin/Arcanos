import { coreAIService } from '../../services/ai-service-consolidated.js';
import type { ChatMessage } from '../../services/unified-openai.js';
import fs from 'fs';
import path from 'path';
import { createServiceLogger } from '../../utils/logger.js';
import { sendEmail } from '../../services/email.js';

const logger = createServiceLogger('EmailDispatcher');

export interface EmailDispatchRequest {
  type: 'audit' | 'task' | 'goal';
  message: string;
  to: string;
  subject: string;
  from?: string;
  stream?: boolean;
  logFilePath?: string;
}

function buildSystemPrompt(type: 'audit' | 'task' | 'goal'): string {
  switch (type) {
    case 'audit':
      return `You are ARCANOS generating an HTML audit summary email. 
      
Create a professional, well-structured HTML email that includes:
- Executive summary of audit findings
- Key issues and recommendations
- Action items with priorities
- Professional formatting with proper HTML structure`;
    case 'task':
      return `You are ARCANOS generating a task alert email in HTML format.
      
Create a clear, actionable HTML email that includes:
- Task details and urgency level
- Required actions and deadlines  
- Contact information if needed
- Professional HTML formatting`;
    case 'goal':
      return `You are ARCANOS generating a goal report email in HTML format.
      
Create an engaging, motivational HTML email that includes:
- Goal progress summary
- Achievements and milestones
- Next steps and recommendations
- Encouraging tone with professional formatting`;
    default:
      return 'You are ARCANOS generating an email in HTML format with professional structure.';
  }
}

async function generateEmailBody({ 
  message, 
  type, 
  stream = false, 
  logFilePath 
}: { 
  message: string; 
  type: 'audit' | 'task' | 'goal'; 
  stream?: boolean; 
  logFilePath?: string; 
}): Promise<string> {
  const logDir = path.join(process.cwd(), 'storage', 'email-logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const finalLogPath = logFilePath || path.join(logDir, `email_${Date.now()}.log`);
  const fileStream = fs.createWriteStream(finalLogPath, { flags: 'a' });

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(type) },
    { role: 'user', content: message }
  ];

  logger.info('Generating email body with core AI service', { type, stream });

  try {
    if (stream) {
      let fullResponse = '';
      const result = await coreAIService.completeStream(
        messages,
        `email-${type}-stream`,
        (token: string) => {
          process.stdout.write(token);
          fileStream.write(token);
          fullResponse += token;
        },
        {
          maxTokens: 1500,
          temperature: 0.6,
          stream: true,
          maxRetries: 3
        }
      );

      fileStream.end();

      if (!result.success) {
        logger.warning('Email generation failed, using fallback', { type, error: result.error });
        return `<html><body><h2>Email Generation Notice</h2><p>AI service temporarily unavailable.</p><pre>${message}</pre></body></html>`;
      }

      logger.success('Email body generation complete (streamed)', { 
        type, 
        contentLength: fullResponse.length,
        logPath: finalLogPath 
      });
      
      return fullResponse;
    }

    const result = await coreAIService.complete(
      messages, 
      `email-${type}`,
      {
        maxTokens: 1500,
        temperature: 0.6,
        maxRetries: 3
      }
    );

    fileStream.write(result.content);
    fileStream.end();

    if (!result.success) {
      logger.warning('Email generation failed, using fallback', { type, error: result.error });
      return `<html><body><h2>Email Generation Notice</h2><p>AI service temporarily unavailable.</p><pre>${message}</pre></body></html>`;
    }

    logger.success('Email body generation complete', { 
      type, 
      contentLength: result.content.length,
      logPath: finalLogPath 
    });
    
    return result.content;
    
  } catch (error: any) {
    fileStream.end();
    logger.error('Email body generation threw error', error, { type });
    return `<html><body><h2>Email Generation Error</h2><p>Failed to generate email content.</p><pre>${message}</pre></body></html>`;
  }
}

export async function dispatchEmail(request: EmailDispatchRequest, maxAttempts = 3): Promise<void> {
  const { type, message, to, subject, from } = request;
  const useStream = request.stream || message.length > 500;

  let html = '';
  try {
    html = await generateEmailBody({ message, type, stream: useStream, logFilePath: request.logFilePath });
  } catch (err: any) {
    logger.error('Email body generation failed', err);
    html = `<html><body><h2>Fallback Email</h2><pre>${message}</pre></body></html>`; // Fallback HTML
  }

  // Enhanced retry logic with exponential backoff
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info('Sending email with retry logic', { attempt, to, subject, type });
      const result = await sendEmail(to, subject, html, from);
      
      if (result.success) {
        logger.success('Email sent successfully', { 
          messageId: result.messageId, 
          attempt,
          type,
          to: to.substring(0, 3) + '***' // Log partial email for privacy
        });
        return;
      }
      
      logger.warning('Email send failed, will retry', { 
        attempt, 
        error: result.error,
        nextAttempt: attempt < maxAttempts ? attempt + 1 : 'none'
      });
      
      // Exponential backoff delay
      if (attempt < maxAttempts) {
        const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s, etc.
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      
    } catch (error: any) {
      logger.error('Email send threw error', error, { attempt, type });
      
      if (attempt < maxAttempts) {
        const delayMs = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  // Log final failure with comprehensive information
  logger.error('All email send attempts failed - email not delivered', { 
    to: to.substring(0, 3) + '***',
    subject: subject.substring(0, 20) + '...',
    type,
    totalAttempts: maxAttempts,
    timestamp: new Date().toISOString()
  });
}
