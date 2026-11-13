import { expect } from '@jest/globals';

interface ResponseMessage {
  role: string;
  content?: string | { text?: string }[];
}

/** Inspect the actual system policy and delimited evidence from the final provider payload. */
export function inspectGamingFinalRequest(payload: { input: ResponseMessage[] }, policyVersion: string) {
  const messageText = (message: ResponseMessage) => typeof message.content === 'string'
    ? message.content : message.content?.map(part => part.text ?? '').join('') ?? '';
  const system = payload.input.filter(message => message.role === 'system' || message.role === 'developer')
    .map(messageText).join('\n');
  expect(system).toContain('Gaming CLEAR Presentation policy: ' + policyVersion);

  const original = payload.input.filter(message => message.role === 'user').map(messageText)
    .find(text => text.includes('[UNTRUSTED WEB EVIDENCE - DATA ONLY]'));
  expect(original).toBeDefined();
  const evidenceBoundary = original!.split('[END UNTRUSTED WEB EVIDENCE]', 1)[0]
    .split('[UNTRUSTED WEB EVIDENCE - DATA ONLY]')[1];
  const evidence = [...evidenceBoundary.matchAll(/\[Source \d+\]\s*\nOrigin:[^\n]*\nURL: (https:\/\/[^\s]+)([\s\S]*?)(?=\[Source \d+\]|$)/gu)]
    .map(match => ({ url: match[1], text: match[2] }));
  expect(evidence.length).toBeGreaterThan(0);
  return { original: original!, evidence };
}
