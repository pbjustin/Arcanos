import axios from 'axios';

export async function bootstrapWorkers(): Promise<void> {
  console.log('[BOOT] Worker initialization sequence started');

  const port = process.env.PORT || '8080';
  const baseUrl = `http://localhost:${port}`;

  const diagnosticsUrl = `${baseUrl}/system/diagnostics`;
  const workersUrl = `${baseUrl}/system/workers`;

  const baseDelay = 5000;
  const maxDelay = 60000;

  async function waitForOk(url: string): Promise<void> {
    let attempt = 0;
    let delay = baseDelay;
    while (true) {
      try {
        const res = await axios.get(url);
        if (res.status === 200) {
          return;
        }
      } catch (err: any) {
        console.error(`[BOOT] Error pinging ${url}:`, err.message);
      }
      await new Promise(res => setTimeout(res, delay));
      attempt += 1;
      delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    }
  }

  await Promise.all([
    waitForOk(diagnosticsUrl),
    waitForOk(workersUrl),
  ]);

  console.log('[WORKERS READY] Diagnostics pipeline confirmed online');
}
