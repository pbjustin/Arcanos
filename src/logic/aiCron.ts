import cron from "node-cron";
import os from "os";
import { writeFileSync } from "fs";

interface HealthSnapshot {
  timestamp: string;
  heap: string;
  uptime: string;
  cpu: number[];
  pid: number;
}

function getHealthSnapshot(): HealthSnapshot {
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  const uptime = process.uptime().toFixed(1);

  return {
    timestamp: new Date().toISOString(),
    heap: `${heapMB}MB`,
    uptime: `${uptime}s`,
    cpu: os.loadavg(),
    pid: process.pid,
  };
}

// Enhanced AI-CRON health monitoring with intelligent logging
cron.schedule("*/5 * * * *", () => {
  const snapshot = getHealthSnapshot();
  console.log(`🧠 ARCANOS:HEALTH | Heap: ${snapshot.heap} | Uptime: ${snapshot.uptime}`);
  
  try {
    writeFileSync("./sandbox/memory/last_snapshot.json", JSON.stringify(snapshot, null, 2));
  } catch (error) {
    console.error("❌ Failed to write health snapshot:", error);
  }
});

console.log("✅ ARCANOS intelligent AI-CRON logging is now active.");

export { getHealthSnapshot };