// Preload for standalone CLI tests: every fetch is synthetic, including failures.
import {
  PROBE_RESPONSES,
  createProbeResponse,
  rejectOnRequestAbort,
} from './railway-probe-responses.js';

globalThis.fetch = async (url, init) => {
  const fixture = process.env.ARCANOS_PROBE_FIXTURE;
  if (fixture === 'network') {
    throw new TypeError('fixture network failure');
  }
  if (fixture === 'timeout') {
    return rejectOnRequestAbort(url, init);
  }
  if (fixture === 'unusual-throw') {
    throw 'fixture thrown string';
  }
  if (fixture === 'queued') {
    return createProbeResponse(
      new URL(url).pathname.startsWith('/gpt/') ? PROBE_RESPONSES.queued : PROBE_RESPONSES.completed
    );
  }
  if (!Object.hasOwn(PROBE_RESPONSES, fixture)) {
    throw new Error('Unknown offline probe fixture.');
  }
  return createProbeResponse(PROBE_RESPONSES[fixture]);
};
