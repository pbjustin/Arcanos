export interface CodexIntent {
  intent: string;
  payload: any;
}

// Very basic intent parser expecting `intent:payload` or JSON
export function validateCodexIntent(prompt: string | undefined): CodexIntent | null {
  if (!prompt || typeof prompt !== 'string') return null;

  const colonIndex = prompt.indexOf(':');
  if (colonIndex === -1) {
    return { intent: prompt.trim(), payload: {} };
  }

  const intent = prompt.slice(0, colonIndex).trim();
  const payloadRaw = prompt.slice(colonIndex + 1).trim();

  let payload: any = payloadRaw;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    // keep as string
  }

  return { intent, payload };
}
