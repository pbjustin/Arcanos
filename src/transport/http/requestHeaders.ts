export type HeaderValue = string | string[] | undefined;

export function normalizeHeaderValue(value: HeaderValue): string | undefined {
  if (!value) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
}

export function resolveHeader(
  headers: Record<string, HeaderValue> | undefined,
  headerName: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  return normalizeHeaderValue(headers[headerName]);
}
