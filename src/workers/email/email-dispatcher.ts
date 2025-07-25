import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import fs from 'fs';
import path from 'path';
import { createServiceLogger } from '../../utils/logger';
import { sendEmail } from '../../services/email';

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
      return 'You are ARCANOS generating an HTML audit summary email.';
    case 'task':
      return 'You are ARCANOS generating a task alert email in HTML format.';
    case 'goal':
      return 'You are ARCANOS generating a goal report email in HTML format.';
    default:
      return 'You are ARCANOS generating an email.';
  }
}

async function generateEmailBody({ message, type, stream = false, logFilePath }: { message: string; type: 'audit' | 'task' | 'goal'; stream?: boolean; logFilePath?: string }): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required');
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const logDir = path.join(process.cwd(), 'storage', 'email-logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const finalLogPath = logFilePath || path.join(logDir, `email_${Date.now()}.log`);
  const fileStream = fs.createWriteStream(finalLogPath, { flags: 'a' });

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(type) },
    { role: 'user', content: message }
  ];

  logger.info('Generating email body', { type });

  if (stream) {
    const streamResp = await openai.chat.completions.create({
      model: 'arcanos-v1',
      messages,
      stream: true
    });

    let fullResponse = '';
    for await (const chunk of streamResp) {
      const token = chunk.choices?.[0]?.delta?.content || '';
      if (token) {
        process.stdout.write(token);
        fileStream.write(token);
        fullResponse += token;
      }
    }

    fileStream.end();
    logger.success('Email body generation complete', { log: finalLogPath });
    return fullResponse;
  }

  const completion = await openai.chat.completions.create({
    model: 'arcanos-v1',
    messages
  });

  const content = completion.choices?.[0]?.message?.content || '';
  fileStream.write(content);
  fileStream.end();

  logger.success('Email body generation complete', { log: finalLogPath });
  return content;
}

export async function dispatchEmail(request: EmailDispatchRequest, maxAttempts = 3): Promise<void> {
  const { type, message, to, subject, from } = request;
  const useStream = request.stream || message.length > 500;

  let html = '';
  try {
    html = await generateEmailBody({ message, type, stream: useStream, logFilePath: request.logFilePath });
  } catch (err: any) {
    logger.error('Email body generation failed', err);
    html = message; // Fallback to raw message
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info('Sending email', { attempt, to, subject });
      const result = await sendEmail(to, subject, html, from);
      if (result.success) {
        logger.success('Email sent', { messageId: result.messageId, attempt });
        return;
      }
      logger.warning('Email send failed', { attempt, error: result.error });
    } catch (error: any) {
      logger.error('Email send threw error', error, { attempt });
    }
  }

  logger.error('All email send attempts failed', { to, subject });
}
