import { EventEmitter } from 'events';

export interface DiagnosticRecord {
  worker: string;
  status: 'success' | 'failed';
  timestamp: string;
  error?: string;
}

const registry: DiagnosticRecord[] = [];
const emitter = new EventEmitter();
const MAX_RECORDS = 500;

export function logRoutingRecord(record: DiagnosticRecord): void {
  registry.push(record);
  if (registry.length > MAX_RECORDS) {
    registry.shift();
  }
  emitter.emit('record', record);
}

export function getDiagnosticRecords(): DiagnosticRecord[] {
  return [...registry];
}

export function onDiagnosticRecord(listener: (record: DiagnosticRecord) => void): void {
  emitter.on('record', listener);
}
