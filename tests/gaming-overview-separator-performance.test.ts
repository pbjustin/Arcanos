import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isGamingDocumentOverviewOnly } from '../src/shared/gaming/gamingDocumentIngestionCore.js';

const heading = 'Elden Ring Practice - Shield guide';
const metadata = { title: heading, headings: heading };
const description = 'This article explains how to acquire the Practice - Shield.';

describe('bounded overview label matching', () => {
  it('contains overlapping-separator attacks without disabling valid nominal labels', () => {
    // Both 250KB inputs are below the existing durable text limit and contain
    // the real description frame, so the ordinary-prose fast path cannot mask them.
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/gaming-overview/separator-performance.cjs', import.meta.url))], {
      encoding: 'utf8', timeout: 8000, windowsHide: true
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ repeatedLabelAttack: false, describedTopicAttack: false, validOverview: true,
      multipleSeparators: { repeatedLabelAttack: false, describedTopicAttack: false, validOverview: true } });
  }, 12000);

  it.each([240, 241])('does not manufacture guidebook completion at label offset %i', offset => {
    const prefix = 'Practice';
    const suffix = '- Shield guide';
    const repeated = prefix + ' '.repeat(offset - prefix.length - suffix.length) + suffix + 'book';
    expect(repeated.indexOf('book')).toBe(offset);
    expect(isGamingDocumentOverviewOnly(`${heading} ${repeated} ${description}`, metadata, 'Elden Ring')).toBe(false);
  });

  it('retains an original whitespace boundary at the existing 240-character label ceiling', () => {
    const repeated = 'Practice' + ' '.repeat(240 - 'Practice'.length - '- Shield guide'.length) + '- Shield guide';
    expect(repeated).toHaveLength(240);
    expect(isGamingDocumentOverviewOnly(`${heading} ${repeated} ${description}`, metadata, 'Elden Ring')).toBe(true);
  });

  it('keeps over-bound direct heading text unconsumed', () => {
    const topic = 'Lumen' + 'a'.repeat(250);
    const longHeading = `Elden Ring ${topic} guide`;
    const text = `${longHeading} This article explains how to acquire the ${topic}.`;
    expect(isGamingDocumentOverviewOnly(text, { title: longHeading, headings: longHeading }, 'Elden Ring')).toBe(false);
  });
});
