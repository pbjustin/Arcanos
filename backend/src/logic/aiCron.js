const cron = require("node-cron");
const os = require("os");

function getHealthSnapshot() {
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  const uptime = process.uptime().toFixed(1);
  return { heapMB, uptime };
}

cron.schedule("*/5 * * * *", () => {
  const { heapMB, uptime } = getHealthSnapshot();
  console.log(`🧠 ARCANOS:HEALTH | Heap: ${heapMB}MB | Uptime: ${uptime}s`);
});
