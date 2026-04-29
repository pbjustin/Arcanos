export function extractMessageContentText(content: unknown): string | null {
  if (typeof content === 'string' && content.trim().length > 0) {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const record = part as Record<string, unknown>;
        return typeof record.text === 'string' ? record.text : '';
      }

      return '';
    })
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join('\n') : null;
}

export function extractLastUserMessageText(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }

    const record = message as Record<string, unknown>;
    if (record.role !== 'user') {
      continue;
    }

    const text = extractMessageContentText(record.content);
    if (text) {
      return text;
    }
  }

  return null;
}
