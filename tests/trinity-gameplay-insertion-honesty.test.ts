import { describe, expect, it } from '@jest/globals';
import {
  createDefaultTrinityReasoningHonesty,
  deriveTrinityCapabilityFlags,
  deriveTrinityOutputControls,
  enforceFinalStageHonestyAndMinimalism
} from '../src/core/logic/trinityHonesty.js';

const userPrompt = 'How do I restart the rainwheel at the Glass Orchard?';
function review(text: string) {
  return enforceFinalStageHonestyAndMinimalism({ text, userPrompt,
    capabilityFlags: deriveTrinityCapabilityFlags(), reasoningHonesty: createDefaultTrinityReasoningHonesty(),
    outputControls: deriveTrinityOutputControls(userPrompt, {}), preservePresentation: true });
}

describe('gameplay insertion instructions retain the backend action boundary', () => {
  it.each([
    'Insert the copper spindle into the rainwheel. [1]',
    'At the Glass Orchard, close the east sluice, insert the copper spindle, and turn the rainwheel three times; wait for the blue water indicator before reopening the sluice. [1]',
    'Close the east sluice and insert a copper spindle before turning the rainwheel. [1]',
    'Close the east sluice; then insert your copper spindle into the rainwheel. [1]',
    '- Insert the copper spindle into the rainwheel. [1]',
    '* Insert the copper spindle into the rainwheel. [1]',
    '+ Insert the copper spindle into the rainwheel. [1]',
    '1. Insert the copper spindle into the rainwheel. [1]',
    '2) Insert the copper spindle into the rainwheel. [1]',
    'Close it and insert the copper spindle into the rainwheel. [1]',
    'Wait until it glows, then insert the copper spindle into the rainwheel. [1]',
    'If it can fit, insert the copper spindle into the rainwheel. [1]',
    'When it will not catch on the rim, insert the copper spindle into the rainwheel. [1]',
    'Insert the copper key into the clockwork keyhole. [1]',
    '- **Insert** the copper spindle into the rainwheel. [1]'
  ])('preserves an imperative with a concrete object: %s', text => {
    expect(review(text)).toMatchObject({ text, blockedOrRewrittenClaims: [] });
  });

  it.each([
    'I insert the copper spindle for you.',
    'We will insert the copper spindle for you.',
    'The assistant will insert the copper spindle for you.',
    'I close the east sluice and insert the copper spindle for you.',
    'We will close the east sluice, then insert the copper spindle for you.',
    'ARCANOS turns the rainwheel and insert the copper spindle for you.',
    'The assistant will close the sluice and insert the spindle for you.',
    'The chatbot will close the east sluice and insert the copper spindle for you.',
    'The browser will close the east sluice and insert the copper spindle for you.',
    'This chat will close the east sluice and insert the copper spindle for you.',
    'ChatGPT will close the east sluice and insert the copper spindle for you.',
    'Insert the record into the database.',
    'Insert your preferences into memory.',
    'Insert the API key into the configuration.',
    'Insert your access token.',
    'Insert your private key into the configuration.',
    'Insert the signing key into the configuration.',
    'Insert your SSH key into the configuration.',
    'Insert the private-key into the configuration.',
    '- Insert your private key into the configuration.',
    'It will close the east sluice and insert the copper spindle for you.',
    "It'll close the east sluice and insert the copper spindle for you.",
    'It would close the east sluice and insert the copper spindle for you.',
    '- It will close the east sluice and insert the copper spindle for you.',
    'At the Glass Orchard, it will close the east sluice and insert the copper spindle for you.',
    'It is going to close the east sluice and insert the copper spindle for you.',
    'It **will** close the east sluice and insert the copper spindle for you.',
    '**It will** close the east sluice and insert the copper spindle for you.',
    'Insert your private RSA key into the hardware signer.',
    'Insert your private RSA-2048 signing key into the hardware signer.',
    'Insert your SSH‑key into the hardware signer.',
    'The **assistant** will close the sluice and insert the copper spindle for you.',
    '- Insert the **API key** into the configuration.',
    'Ｉｎｓｅｒｔ your private RSA key into the hardware signer.',
    'In**sert** your private RSA key into the hardware signer.',
    'Insert it.',
    'Insert.',
    'Insert the copper spindle, and I insert it for you.',
    'Insert the copper spindle, and I saved your progress.',
    'Insert the copper spindle, and we updated the database.',
    'I inserted the copper spindle for you.',
    'Insert the copper spindle, then insert your credentials into storage.'
  ])('continues to withhold ambiguous or unsupported action claims: %s', text => {
    const result = review(text);
    expect(result.text).not.toBe(text);
    expect(result.blockedOrRewrittenClaims.length).toBeGreaterThan(0);
  });
});
