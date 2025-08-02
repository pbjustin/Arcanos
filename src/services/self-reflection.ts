import { databaseService } from './database';
import cron from 'node-cron';
import { ARCANOS_MODEL_ID } from '../config/ai-model';

interface ReflectionEntry {
  timestamp: string;
  content: any;
  context_id?: string;
  interaction_id?: string;
  source: string;
}

export class SelfReflectionService {
  private snapshotKey: string | null = null;
  private pending: ReflectionEntry[] = [];
  private flushTimer?: NodeJS.Timeout;

  constructor() {
    this.scheduleFlush();
  }

  async saveSelfReflection(reflection: any, context_id?: string, interaction_id?: string): Promise<void> {
    const entry: ReflectionEntry = {
      timestamp: new Date().toISOString(),
      content: reflection,
      context_id,
      interaction_id,
      source: ARCANOS_MODEL_ID
    };
    this.pending.push(entry);
    await this.persist();
  }

  private async ensureSnapshot(): Promise<void> {
    if (this.snapshotKey) return;
    const all = await databaseService.loadAllMemory('system');
    const snapshot = all.find(r => r.memory_key.startsWith('system_snapshot_'));
    if (snapshot) {
      this.snapshotKey = snapshot.memory_key;
    } else {
      const key = `system_snapshot_${Date.now()}`;
      const value = {
        snapshot_id: key,
        method: 'runtime',
        memory_count: 0,
        created_at: new Date().toISOString(),
        memories: [] as ReflectionEntry[]
      };
      await databaseService.saveMemory({ memory_key: key, memory_value: value, container_id: 'system' });
      this.snapshotKey = key;
    }
  }

  private async persist(): Promise<void> {
    if (this.pending.length === 0) return;
    await this.ensureSnapshot();
    if (!this.snapshotKey) return;
    const record = await databaseService.loadMemory({ memory_key: this.snapshotKey, container_id: 'system' });
    const value = record?.memory_value || { memories: [] };
    value.memories = value.memories || [];

    for (const entry of this.pending) {
      const exists = value.memories.some((m: ReflectionEntry) =>
        JSON.stringify(m.content) === JSON.stringify(entry.content) &&
        m.context_id === entry.context_id &&
        m.interaction_id === entry.interaction_id
      );
      if (!exists) {
        value.memories.push(entry);
      }
    }

    value.memory_count = Array.isArray(value.memories) ? value.memories.length : value.memories?.length || 0;
    await databaseService.saveMemory({ memory_key: this.snapshotKey, memory_value: value, container_id: 'system' });
    this.pending = [];
  }

  private scheduleFlush(): void {
    this.flushTimer = setInterval(() => this.persist().catch(err => console.error('SelfReflection flush error', err)), 30 * 60 * 1000);
    try {
      cron.schedule('*/30 * * * *', () => this.persist().catch(err => console.error('SelfReflection cron flush error', err)));
    } catch (err) {
      console.warn('CRON scheduling failed for self-reflection flush');
    }
    process.on('exit', () => this.flushPending());
  }

  async flushPending(): Promise<void> {
    await this.persist();
    if (this.flushTimer) clearInterval(this.flushTimer);
  }
}

export const selfReflectionService = new SelfReflectionService();
