import { Readable } from 'node:stream';

/** Adapt a deterministic Axios fixture to the protected streaming request; never performs network IO. */
export function gamingAcquisitionResponse(response: {
  data: unknown; status?: number; headers?: Record<string, unknown>; rawHeaders?: string[];
}, options?: { responseType?: string }) {
  if (options?.responseType !== 'stream' || response.data instanceof Readable) return response;
  const data = Readable.from([Buffer.from(String(response.data))]);
  Object.assign(data, { rawHeaders: response.rawHeaders ?? Object.entries(response.headers ?? {})
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => Array.isArray(value) ? value.flatMap(entry => [key, String(entry)]) : [key, String(value)]) });
  return { ...response, status: response.status ?? 200, data };
}

/** Match the isolated core client and legacy get seam without replacing the protected hop/loop. */
export function gamingAcquisitionAxios(get: (url: string, options?: Record<string, unknown>) => unknown) {
  const protectedGet = async (url: string, options?: Record<string, unknown>) => gamingAcquisitionResponse(
    await get(url, options) as Parameters<typeof gamingAcquisitionResponse>[0], options
  );
  return {
    get: protectedGet,
    Axios: class { get = protectedGet; },
    getAdapter: () => 'synthetic-http-fixture'
  };
}
