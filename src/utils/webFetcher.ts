/**
 * Simple wrapper around the global fetch API.
 * Throws an error for non-2xx responses and automatically
 * parses JSON responses based on the content-type header.
 */
export async function webFetcher<T = unknown>(
  url: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(url, options);

  const contentType = res.headers.get('content-type') || '';
  const bodyText = await res.text();

  if (!res.ok) {
    const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 300);
    const bodyInfo = snippet ? ` Body: ${snippet}` : '';
    throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}.${bodyInfo}`);
  }

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(bodyText) as T;
    } catch (err) {
      throw new Error(`Failed to parse JSON response from ${url}: ${(err as Error).message}`);
    }
  }

  return bodyText as unknown as T;
}

export default webFetcher;
