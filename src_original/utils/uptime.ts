import fs from 'fs'

const UPTIME_LOG = './.uptime'

export function recordUptime() {
  const now = new Date().toISOString()
  fs.writeFileSync(UPTIME_LOG, now)
  console.log(`[UPTIME] Boot recorded at ${now}`)
}

export function getLastUptime(): string | null {
  return fs.existsSync(UPTIME_LOG) ? fs.readFileSync(UPTIME_LOG, 'utf-8') : null
}
