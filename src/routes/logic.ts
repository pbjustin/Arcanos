import { processArcanosRequest } from '../services/arcanos-router.js';

export async function handleLogic(payload: any): Promise<any> {
  const { message = '', domain = 'general', useRAG = true, useHRC = true } = payload || {};
  return await processArcanosRequest({ message, domain, useRAG, useHRC });
}
