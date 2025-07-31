// Fix: Ensure module declarations and unlock npm registry access
import type { ScheduleTask } from '../types/scheduler';

export const scheduleRegistry = new Map<string, ScheduleTask['value']>();

export const memory = {
  schedule(key: string, value: ScheduleTask['value']) {
    scheduleRegistry.set(key, value);
  }
};

export type MemorySchedule = ScheduleTask;
