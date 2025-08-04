import { diagnosticsService } from '../services/diagnostics.js';

export async function runDiagnostics(payload: any): Promise<any> {
  const command = typeof payload === 'string' ? payload : payload?.command;
  return diagnosticsService.executeDiagnosticCommand(command || 'system health');
}
