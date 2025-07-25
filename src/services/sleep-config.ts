// 🔒 CORE BACKEND — COPILOT COMMAND BLOCK: SCHEDULED SLEEP CONFIG
// Purpose: Access sleep window configuration for core system (non-Booker)
// Sleep Window: 7:00 AM to 2:00 PM Eastern Time daily

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
  const now = new Date();
  
  // Convert to Eastern Time (handle DST automatically)
  const easternTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const easternHour = easternTime.getHours();
  
  // Sleep window: 7 AM to 2 PM ET (7-14 hours)
  const sleepStart = 7;  // 7:00 AM ET
  const sleepEnd = 14;   // 2:00 PM ET
  
  const inSleepWindow = easternHour >= sleepStart && easternHour < sleepEnd;
  
  // Calculate next sleep start/end times
  const todayEastern = new Date(easternTime);
  todayEastern.setHours(sleepStart, 0, 0, 0);
  
  const tomorrowEastern = new Date(todayEastern);
  tomorrowEastern.setDate(tomorrowEastern.getDate() + 1);
  
  const todayWakeEastern = new Date(easternTime);
  todayWakeEastern.setHours(sleepEnd, 0, 0, 0);
  
  let nextSleepStart: Date;
  let nextSleepEnd: Date;
  
  if (easternHour < sleepStart) {
    // Before sleep window today
    nextSleepStart = todayEastern;
    nextSleepEnd = todayWakeEastern;
  } else if (easternHour < sleepEnd) {
    // Currently in sleep window
    nextSleepStart = tomorrowEastern;
    nextSleepEnd = todayWakeEastern;
  } else {
    // After sleep window today
    nextSleepStart = tomorrowEastern;
    const tomorrowWakeEastern = new Date(tomorrowEastern);
    tomorrowWakeEastern.setHours(sleepEnd, 0, 0, 0);
    nextSleepEnd = tomorrowWakeEastern;
  }
  
  const timeUntilSleep = inSleepWindow ? undefined : Math.max(0, Math.floor((nextSleepStart.getTime() - now.getTime()) / 60000));
  const timeUntilWake = inSleepWindow ? Math.max(0, Math.floor((nextSleepEnd.getTime() - now.getTime()) / 60000)) : undefined;
  
  return {
    inSleepWindow,
    nextSleepStart,
    nextSleepEnd,
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
  const now = new Date();
  
  if (status.inSleepWindow) {
    console.log(`[SLEEP-WINDOW] 😴 Currently in sleep window (7 AM - 2 PM ET)`);
    console.log(`[SLEEP-WINDOW] ⏰ Wake up in ${status.timeUntilWake} minutes at ${status.nextSleepEnd?.toLocaleString()}`);
  } else {
    console.log(`[SLEEP-WINDOW] 🌅 Currently awake (outside 7 AM - 2 PM ET)`);
    console.log(`[SLEEP-WINDOW] ⏰ Sleep in ${status.timeUntilSleep} minutes at ${status.nextSleepStart?.toLocaleString()}`);
  }
}