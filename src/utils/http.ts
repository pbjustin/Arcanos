export interface SafeFetchHtmlResult {
  raw: string | null;
  error: string | null;
  status?: number;
  contentType?: string;
}

const HTML_CONTENT_TYPE = /text\/html/i;
const DEFAULT_TIMEOUT_MS = 10000;

function buildErrorResult(message: string, status?: number, contentType?: string): SafeFetchHtmlResult {
  return {
    raw: null,
    error: message,
    status,
    contentType
  };
}

/**
 * Safely fetch HTML content while enforcing content-type validation and timeouts.
 * Never throws; instead returns a structured result indicating success or failure.
 */
export async function safeFetchHtml(url: string, options: RequestInit = {}): Promise<SafeFetchHtmlResult> {
  try {
    // Validate URL upfront to avoid runtime fetch errors.
    new URL(url);
  } catch {
    return buildErrorResult('Invalid URL provided');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      ...options,
      signal: controller.signal
    });

    const contentType = response.headers.get('content-type') ?? undefined;

    if (!response.ok) {
      return buildErrorResult(`Request failed with status ${response.status}`, response.status, contentType);
    }

    if (!contentType || !HTML_CONTENT_TYPE.test(contentType)) {
      return buildErrorResult('Response is not HTML content', response.status, contentType);
    }

    const raw = await response.text();
    return { raw, error: null, status: response.status, contentType };
  } catch (error) {
    const message = (error as Error)?.name === 'AbortError'
      ? 'Request timed out'
      : (error instanceof Error ? error.message : 'Unknown error');

    return buildErrorResult(message);
  } finally {
    clearTimeout(timeout);
  }
}
