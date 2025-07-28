/**
 * Centralized Scheduler Configuration
 * Replaces hard-coded schedule patterns with typed constants
 */

export interface ScheduleConfig {
  id: string;
  name: string;
  cronExpression: string;
  workerType: string;
  enabled: boolean;
  description: string;
  timezone: string;
  maxRetries: number;
  retryDelayMs: number;
}

export const SCHEDULE_CONSTANTS = {
  TIMEZONES: {
    UTC: 'UTC',
    EST: 'America/New_York',
    PST: 'America/Los_Angeles'
  },
  
  COMMON_CRONS: {
    EVERY_MINUTE: '* * * * *',
    EVERY_5_MINUTES: '*/5 * * * *',
    EVERY_15_MINUTES: '*/15 * * * *',
    EVERY_30_MINUTES: '*/30 * * * *',
    HOURLY: '0 * * * *',
    DAILY_MIDNIGHT: '0 0 * * *',
    DAILY_NOON: '0 12 * * *',
    WEEKLY_SUNDAY: '0 0 * * 0',
    MONTHLY_FIRST: '0 0 1 * *'
  },

  DEFAULT_RETRY: {
    maxRetries: 3,
    retryDelayMs: 5000
  }
} as const;

export const WORKER_SCHEDULES: ScheduleConfig[] = [
  {
    id: 'maintenance-daily',
    name: 'Daily Maintenance',
    cronExpression: SCHEDULE_CONSTANTS.COMMON_CRONS.DAILY_MIDNIGHT,
    workerType: 'maintenanceScheduler',
    enabled: true,
    description: 'Daily system maintenance and cleanup',
    timezone: SCHEDULE_CONSTANTS.TIMEZONES.UTC,
    maxRetries: SCHEDULE_CONSTANTS.DEFAULT_RETRY.maxRetries,
    retryDelayMs: SCHEDULE_CONSTANTS.DEFAULT_RETRY.retryDelayMs
  },
  {
    id: 'email-processor',
    name: 'Email Processing',
    cronExpression: SCHEDULE_CONSTANTS.COMMON_CRONS.EVERY_5_MINUTES,
    workerType: 'emailDispatcher',
    enabled: true,
    description: 'Process pending email queue',
    timezone: SCHEDULE_CONSTANTS.TIMEZONES.UTC,
    maxRetries: SCHEDULE_CONSTANTS.DEFAULT_RETRY.maxRetries,
    retryDelayMs: SCHEDULE_CONSTANTS.DEFAULT_RETRY.retryDelayMs
  },
  {
    id: 'goal-tracker',
    name: 'Goal Tracking',
    cronExpression: SCHEDULE_CONSTANTS.COMMON_CRONS.HOURLY,
    workerType: 'goalTracker',
    enabled: true,
    description: 'Monitor and track goal progress',
    timezone: SCHEDULE_CONSTANTS.TIMEZONES.UTC,
    maxRetries: SCHEDULE_CONSTANTS.DEFAULT_RETRY.maxRetries,
    retryDelayMs: SCHEDULE_CONSTANTS.DEFAULT_RETRY.retryDelayMs
  },
  {
    id: 'audit-processor',
    name: 'Audit Processing',
    cronExpression: SCHEDULE_CONSTANTS.COMMON_CRONS.EVERY_30_MINUTES,
    workerType: 'auditProcessor',
    enabled: true,
    description: 'Process audit logs and generate reports',
    timezone: SCHEDULE_CONSTANTS.TIMEZONES.UTC,
    maxRetries: SCHEDULE_CONSTANTS.DEFAULT_RETRY.maxRetries,
    retryDelayMs: SCHEDULE_CONSTANTS.DEFAULT_RETRY.retryDelayMs
  }
];

export function getScheduleConfig(workerId: string): ScheduleConfig | undefined {
  return WORKER_SCHEDULES.find(config => config.id === workerId);
}

export function getWorkerSchedules(workerType: string): ScheduleConfig[] {
  return WORKER_SCHEDULES.filter(config => config.workerType === workerType);
}

export function isValidCronExpression(cron: string): boolean {
  // Basic cron validation - can be enhanced with a proper cron library
  const cronRegex = /^(\*|([0-5]?\d)) (\*|([01]?\d|2[0-3])) (\*|([01]?\d|2\d|3[01])) (\*|([01]?\d)) (\*|([0-6]))$/;
  return cronRegex.test(cron);
}