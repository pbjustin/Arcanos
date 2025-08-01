import fs from 'fs';
import path from 'path';

/**
 * Records process uptime to storage/uptime.log at a fixed interval.
 */
export function recordUptime(intervalMs = 60_000) {
  const dir = path.join(__dirname, '../storage');
  const file = path.join(dir, 'uptime.log');
  fs.mkdirSync(dir, { recursive: true });

  const log = () => {
    const seconds = Math.round(process.uptime());
    const stamp = new Date().toISOString();
    fs.appendFileSync(file, `${stamp} uptime=${seconds}s\n`);
  };

  log();
  setInterval(log, intervalMs);
}
