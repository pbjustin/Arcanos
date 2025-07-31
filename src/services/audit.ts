import { ArcanosAuditService } from './arcanos-audit';

const auditService = new ArcanosAuditService();

export async function handleAudit(payload: any): Promise<any> {
  const { message, domain = 'general', useHRC = true } = payload || {};
  if (!message) {
    throw new Error('message is required');
  }
  return await auditService.processAuditRequest({ message, domain, useHRC });
}
