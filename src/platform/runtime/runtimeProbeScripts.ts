export const RUNTIME_PROBE_SUMMARY_SCRIPT = `
const summary = {
  nodeVersion: process.version,
  hasFetch: typeof fetch === 'function',
  hasIntl: typeof Intl !== 'undefined'
};
console.log(JSON.stringify(summary));
`;
