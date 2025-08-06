export async function runHealthCheck() {
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  const uptime = process.uptime().toFixed(1);
  return {
    summary: `Heap: ${heapMB}MB | Uptime: ${uptime}s`,
    raw: mem
  };
}