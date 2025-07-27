import fs from 'fs'
import path from 'path'
import { createServiceLogger } from '../utils/logger'

const logger = createServiceLogger('DiagnosticsMiddleware')

export interface DiagnosticPayload {
  error: any
  fallbackResult: any
}

export function trackDiagnostics(payload: DiagnosticPayload): void {
  const logDir = path.join(process.cwd(), 'storage', 'diagnostics')
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  const logPath = path.join(logDir, `diagnostic_${new Date().toISOString().slice(0,10)}.log`)
  const entry = {
    ...payload,
    timestamp: new Date().toISOString()
  }
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n')
  logger.info('Diagnostics event tracked', { logPath })
}
