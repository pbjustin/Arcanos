import { createHash } from 'node:crypto';

import { normalizeBackstageNotionPageId } from './backstageNotionRagCore.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type BackstageNotionPageMaterialState =
  | 'added'
  | 'changed'
  | 'moved'
  | 'deleted'
  | 'unchanged';

export interface BackstageNotionPageMaterialIdentity {
  readonly pageId: string;
  readonly contentHash: string;
  readonly parentPageId: string | null;
  readonly title: string;
  readonly path: readonly string[];
}

export interface BackstageNotionPageMaterialClassification {
  readonly pageId: string;
  readonly state: BackstageNotionPageMaterialState;
  readonly contentChanged: boolean;
  readonly placementChanged: boolean;
  readonly previous: BackstageNotionPageMaterialIdentity | null;
  readonly current: BackstageNotionPageMaterialIdentity | null;
}

/**
 * Hash only normalized, sanitized Markdown. Placement and page identity remain
 * separate immutable provenance so moves can reuse the same material.
 */
export function hashBackstageNotionPageMaterial(sanitizedMarkdown: string): string {
  if (typeof sanitizedMarkdown !== 'string' || sanitizedMarkdown.includes('\u0000')) {
    throw new TypeError('Backstage Notion page material must be a valid string.');
  }
  return createHash('sha256').update(sanitizedMarkdown, 'utf8').digest('hex');
}

function normalizeText(value: string, label: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\u0000')
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function normalizeIdentity(
  value: BackstageNotionPageMaterialIdentity,
  label: string
): BackstageNotionPageMaterialIdentity {
  const pageId = normalizeBackstageNotionPageId(value.pageId);
  const parentPageId = value.parentPageId === null
    ? null
    : normalizeBackstageNotionPageId(value.parentPageId);
  if (!pageId || (value.parentPageId !== null && !parentPageId)) {
    throw new TypeError(`${label} contains an invalid Notion page ID.`);
  }
  if (!SHA256_PATTERN.test(value.contentHash)) {
    throw new TypeError(`${label}.contentHash is invalid.`);
  }
  if (!Array.isArray(value.path) || value.path.length === 0) {
    throw new TypeError(`${label}.path is invalid.`);
  }
  return Object.freeze({
    pageId,
    contentHash: value.contentHash,
    parentPageId,
    title: normalizeText(value.title, `${label}.title`),
    path: Object.freeze(value.path.map((segment, index) =>
      normalizeText(segment, `${label}.path[${index}]`)
    )),
  });
}

function indexIdentities(
  values: readonly BackstageNotionPageMaterialIdentity[],
  label: string
): ReadonlyMap<string, BackstageNotionPageMaterialIdentity> {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array.`);
  }
  const indexed = new Map<string, BackstageNotionPageMaterialIdentity>();
  values.forEach((value, index) => {
    const normalized = normalizeIdentity(value, `${label}[${index}]`);
    if (indexed.has(normalized.pageId)) {
      throw new TypeError(`${label} contains duplicate page identity.`);
    }
    indexed.set(normalized.pageId, normalized);
  });
  return indexed;
}

function placementMatches(
  left: BackstageNotionPageMaterialIdentity,
  right: BackstageNotionPageMaterialIdentity
): boolean {
  return left.parentPageId === right.parentPageId
    && left.title === right.title
    && left.path.length === right.path.length
    && left.path.every((segment, index) => segment === right.path[index]);
}

/** Classify a complete before/after page inventory without provider access. */
export function classifyBackstageNotionPageMaterials(
  previousValues: readonly BackstageNotionPageMaterialIdentity[],
  currentValues: readonly BackstageNotionPageMaterialIdentity[]
): readonly BackstageNotionPageMaterialClassification[] {
  const previous = indexIdentities(previousValues, 'previous');
  const current = indexIdentities(currentValues, 'current');
  const pageIds = [...new Set([...previous.keys(), ...current.keys()])].sort();

  return Object.freeze(pageIds.map(pageId => {
    const before = previous.get(pageId) ?? null;
    const after = current.get(pageId) ?? null;
    const contentChanged = before !== null
      && after !== null
      && before.contentHash !== after.contentHash;
    const placementChanged = before !== null
      && after !== null
      && !placementMatches(before, after);
    const state: BackstageNotionPageMaterialState = before === null
      ? 'added'
      : after === null
        ? 'deleted'
        : contentChanged
          ? 'changed'
          : placementChanged
            ? 'moved'
            : 'unchanged';
    return Object.freeze({
      pageId,
      state,
      contentChanged,
      placementChanged,
      previous: before,
      current: after,
    });
  }));
}
