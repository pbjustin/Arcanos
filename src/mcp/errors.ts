export type McpErrorCode =
  | 'ERR_AUTH'
  | 'ERR_ORIGIN'
  | 'ERR_GATED'
  | 'ERR_DISABLED'
  | 'ERR_CONFIRM_REQUIRED'
  | 'ERR_CONFIRM_INVALID'
  | 'ERR_NOT_FOUND'
  | 'ERR_BAD_REQUEST'
  | 'ERR_TIMEOUT'
  | 'ERR_INTERNAL';

export interface McpErrorShape {
  code: McpErrorCode;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export function mcpError(
  error: McpErrorShape,
  opts?: { asTextJson?: boolean }
): { content: Array<{ type: 'text'; text: string }>; structuredContent: any; isError: true } {
  const body = { error };
  const text = (opts?.asTextJson ?? true) ? JSON.stringify(body, null, 2) : error.message;

  return {
    content: [{ type: 'text', text }],
    structuredContent: body,
    isError: true,
  };
}

export function mcpText(content: unknown) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  //audit Assumption: MCP structuredContent should be an object for broad client compatibility; risk: array/scalar payload rejection; invariant: structuredContent is always a record; handling: wrap non-object values under `value`.
  const structuredContent =
    content && typeof content === 'object' && !Array.isArray(content)
      ? content
      : { value: content };
  return { content: [{ type: 'text', text }], structuredContent };
}
