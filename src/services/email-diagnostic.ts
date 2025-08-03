import { randomUUID } from 'crypto';
import { sendEmail } from './email.js';
import { sendEmailFallback } from '../plugins/email.js';
import { createServiceLogger } from '../utils/logger.js';

async function getReceiptFailMap() {
  try {
    const module = await import('../../memory/modules/receipt_fail_map.js' as any);
    return module;
  } catch {
    return { flag: async () => {} }; // Mock implementation
  }
}

async function getEmailDiagnostics() {
  try {
    const module = await import('../../memory/modules/email_diagnostics.js' as any);
    return module;
  } catch {
    return { add: async () => {} }; // Mock implementation
  }
}

export interface DiagnosticAttempt {
  attemptId: string;
  provider: string;
  response: any;
}

export interface EmailDiagnosticResult {
  attempts: DiagnosticAttempt[];
  finalStatus: 'sent' | 'failed';
  diagnosticId: string;
}

const logger = createServiceLogger('EmailDiagnostic');

export async function runEmailDiagnostic(to: string, subject: string, html: string, from?: string): Promise<EmailDiagnosticResult> {
  const diagnosticId = `ARC-${randomUUID()}`;
  const attempts: DiagnosticAttempt[] = [];
  const backoffs = [100, 300, 1000];
  let finalStatus: 'sent' | 'failed' = 'failed';

  for (let i = 0; i < backoffs.length; i++) {
    const attemptId = `${Date.now()}-${randomUUID()}`;
    try {
      logger.info('Attempting email send', { attempt: i + 1 });
      const result = await sendEmail(to, subject, html, from);
      attempts.push({ attemptId, provider: result.transportType || 'unknown', response: result });

      logger.info('Diagnostic attempt logged', { attemptId });
      if (result.success) {
        finalStatus = 'sent';
        break;
      }
    } catch (err: any) {
      attempts.push({ attemptId, provider: 'primary', response: { error: err.message } });
      logger.error('Send error', err, { attemptId });
    }

    if (i < backoffs.length - 1) {
      await new Promise(res => setTimeout(res, backoffs[i]));
    }
  }

  if (finalStatus === 'failed') {
    const fallbackResult = await sendEmailFallback({ to, subject, html, from });
    attempts.push({
      attemptId: `${Date.now()}-${randomUUID()}`,
      provider: 'fallback',
      response: { ...fallbackResult, fallbackPath: true }
    });
    const receiptFailMap = await getReceiptFailMap();
    await receiptFailMap.flag(to);
  }

  const result: EmailDiagnosticResult = { attempts, finalStatus, diagnosticId };
  const emailDiagnostics = await getEmailDiagnostics();
  await emailDiagnostics.add(result);
  logger.info('Diagnostic complete', result);
  return result;
}
