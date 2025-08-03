let errorLog = [];

export function logError(err) {
  errorLog.push({ message: err.message || 'Unknown error', time: new Date().toISOString() });
  if (errorLog.length > 50) errorLog.shift();
}

export function getErrorCount() {
  return errorLog.length;
}