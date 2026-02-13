export function logTelemetry(data: any) {
  console.log(JSON.stringify({
    timestamp: Date.now(),
    ...data
  }));
}
