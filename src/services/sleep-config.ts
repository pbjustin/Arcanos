// 🔒 CORE BACKEND — COPILOT COMMAND BLOCK: SCHEDULED SLEEP CONFIG
// Purpose: Access sleep window configuration for core system (non-Booker)

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