// Synthetic responses shared by offline probe regressions and CLI fixtures.
export const PROBE_RESPONSES = Object.freeze({
  inline: {
    status: 200,
    bodyText: JSON.stringify({
      routeDecision: { path: 'fast_path', queueBypassed: true, reason: 'fixture' },
      result: 'fixture result',
    }),
  },
  queued: {
    status: 202,
    bodyText: JSON.stringify({ jobId: 'job-fixture', poll: '/jobs/job-fixture', status: 'queued' }),
  },
  pending: { status: 200, bodyText: JSON.stringify({ status: 'pending' }) },
  completed: { status: 200, bodyText: JSON.stringify({ status: 'completed' }) },
  cancelled: { status: 200, bodyText: JSON.stringify({ status: 'cancelled' }) },
  expired: { status: 200, bodyText: JSON.stringify({ status: 'expired' }) },
  malformed: { status: 200, bodyText: '{fixture malformed JSON' },
});

export function createProbeResponse({ status = 200, bodyText = '', headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => bodyText,
  };
}

export function rejectOnRequestAbort(_url, { signal }) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
