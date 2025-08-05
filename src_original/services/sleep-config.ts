// 🔒 CORE BACKEND — COPILOT COMMAND BLOCK: SCHEDULED SLEEP CONFIG
// Purpose: Access sleep window configuration for core system (non-Booker)
// Sleep Window: 7:00 AM to 2:00 PM Eastern Time daily
import { DateTime } from 'luxon';

export interface SleepConfig {
  enabled: boolean;
  start_time_utc: string;
  duration_hours: number;
  timezone: string;
}

export interface ProcessedSleepWindow {
  active: boolean;
  startUTC?: string;
  endUTC?: string;
  duration?: number;
}

export interface SleepWindowStatus {
  inSleepWindow: boolean;
  nextSleepStart?: Date;
  nextSleepEnd?: Date;
  timeUntilSleep?: number; // minutes
  timeUntilWake?: number; // minutes
}

// ✅ Fetch + Logic Wrapper:
export async function getCoreSleepWindow(): Promise<ProcessedSleepWindow> {
  try {
    const res = await fetch('/api/config/sleep');
    if (!res.ok) throw new Error('Sleep config fetch failed');
    const { start_time_utc, duration_hours, enabled }: SleepConfig = await res.json();

    const [startH, startM] = start_time_utc.split(':').map(Number);
    const endH = (startH + duration_hours) % 24;
    const endTimeUTC = `${String(endH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;

    return {
      active: enabled,
      startUTC: start_time_utc,
      endUTC: endTimeUTC,
      duration: duration_hours
    };
  } catch (err) {
    console.error('Core backend sleep window error:', err);
    return { active: false };
  }
}

// 🧠 Copilot Usage:
// - Schedule safe times for deployment or resource-intensive jobs
// - Avoid automated requests during sleep window
// - Sync with monitoring/alert silencing during downtime

// ✅ NEW: SYSTEM CORE — COPILOT COMMAND BLOCK: AUTO-CONNECT TO SLEEP SCHEDULE
// Purpose: Retrieve and interpret the backend's active sleep schedule from a live API

export interface ActiveSleepScheduleResponse {
  active: boolean;
  startUTC?: string;
  endUTC?: string;
  duration?: number;
  timezone?: string;
}

// ✅ NEW: SLEEP WINDOW DETECTION AND MANAGEMENT
// Sleep Window: 7:00 AM to 2:00 PM Eastern Time (UTC-5/-4 depending on DST)

/**
 * Get current Eastern Time sleep window status
 * Sleep window: 7:00 AM to 2:00 PM ET daily
 */
export function getCurrentSleepWindowStatus(): SleepWindowStatus {
  // Current time in Eastern Time using luxon (handles DST)
  const nowET = DateTime.now().setZone('America/New_York');

  const sleepStart = 7; // 7:00 AM ET
  const sleepEnd = 14;  // 2:00 PM ET
  const easternHour = nowET.hour;

  const inSleepWindow = easternHour >= sleepStart && easternHour < sleepEnd;

  // Calculate next sleep start/end times in ET
  let nextSleepStartET: DateTime;
  let nextSleepEndET: DateTime;

  if (easternHour < sleepStart) {
    nextSleepStartET = nowET.set({ hour: sleepStart, minute: 0, second: 0, millisecond: 0 });
    nextSleepEndET = nowET.set({ hour: sleepEnd, minute: 0, second: 0, millisecond: 0 });
  } else if (easternHour < sleepEnd) {
    nextSleepStartET = nowET.plus({ days: 1 }).set({ hour: sleepStart, minute: 0, second: 0, millisecond: 0 });
    nextSleepEndET = nowET.set({ hour: sleepEnd, minute: 0, second: 0, millisecond: 0 });
  } else {
    nextSleepStartET = nowET.plus({ days: 1 }).set({ hour: sleepStart, minute: 0, second: 0, millisecond: 0 });
    nextSleepEndET = nowET.plus({ days: 1 }).set({ hour: sleepEnd, minute: 0, second: 0, millisecond: 0 });
  }

  const timeUntilSleep = inSleepWindow ? undefined : Math.max(0, Math.round(nextSleepStartET.diff(nowET, 'minutes').minutes));
  const timeUntilWake = inSleepWindow ? Math.max(0, Math.round(nextSleepEndET.diff(nowET, 'minutes').minutes)) : undefined;

  return {
    inSleepWindow,
    nextSleepStart: nextSleepStartET.toJSDate(),
    nextSleepEnd: nextSleepEndET.toJSDate(),
    timeUntilSleep,
    timeUntilWake
  };
}

/**
 * Check if server should be in reduced activity mode
 */
export function shouldReduceServerActivity(): boolean {
  const sleepStatus = getCurrentSleepWindowStatus();
  return sleepStatus.inSleepWindow;
}

/**
 * Log current sleep window status
 */
export function logSleepWindowStatus(): void {
  const status = getCurrentSleepWindowStatus();
  
  if (status.inSleepWindow) {
    console.log(`[SLEEP-WINDOW] 😴 Currently in sleep window (7 AM - 2 PM ET)`);
    console.log(`[SLEEP-WINDOW] ⏰ Wake up in ${status.timeUntilWake} minutes at ${status.nextSleepEnd?.toLocaleString()}`);
  } else {
    console.log(`[SLEEP-WINDOW] 🌅 Currently awake (outside 7 AM - 2 PM ET)`);
    console.log(`[SLEEP-WINDOW] ⏰ Sleep in ${status.timeUntilSleep} minutes at ${status.nextSleepStart?.toLocaleString()}`);
  }
}