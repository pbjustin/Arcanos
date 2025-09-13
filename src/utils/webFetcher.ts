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

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }

  return (await res.text()) as unknown as T;
}

export default webFetcher;
