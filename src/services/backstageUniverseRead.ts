import * as coreDb from '@core/db/index.js';
import {
  BACKSTAGE_UNIVERSE_ID_PATTERN,
  BackstageCanonDomainError,
  BackstageBookerRepositoryUnavailableError,
  createBackstageBookerRepository,
  isBackstageBookerLegacyReadQuarantinedError,
  type BackstageCanonBeatRecord,
  type BackstageCanonStorylineSummaryRecord,
  type BackstageCanonStorylineRecord,
  type BackstageContext,
  type PostgresBackstageBookerRepository,
} from '@core/db/repositories/backstageBookerRepository.js';
import {
  BACKSTAGE_SAVED_STORYLINE_EXCERPT_CODE_POINTS,
  BACKSTAGE_STORYLINE_SUMMARY_MAX_CODE_POINTS,
  BACKSTAGE_STORYLINE_SUMMARY_PAGE_CODE_POINTS,
  projectBackstageSavedStorylineExcerpt,
  projectBackstageStorylineSummaryPage,
} from '@shared/backstage/backstageUniverseReadProjection.js';
import { BackstageNotionAuthorityReadQuarantinedError } from './backstageBookerContracts.js';
import { isBackstageNotionAuthorityEnforced } from './backstageNotionAuthority.js';

export {
  BACKSTAGE_STORYLINE_SUMMARY_MAX_CODE_POINTS,
  BACKSTAGE_STORYLINE_SUMMARY_PAGE_CODE_POINTS,
} from '@shared/backstage/backstageUniverseReadProjection.js';

export const BACKSTAGE_UNIVERSE_READ_RESULT_LIMIT_BYTES = 60 * 1024;
// loadContext performs seven bounded SELECTs; 3.5s each leaves room for the
// pool's connection wait and HTTP overhead inside ChatGPT's 45s Action limit.
export const BACKSTAGE_UNIVERSE_READ_DB_STATEMENT_TIMEOUT_MS = 3_500;

export const BACKSTAGE_UNIVERSE_READ_SOURCE_LIMITS = Object.freeze({
  roster: 25,
  recentEvents: 5,
  recentStoryBeats: 5,
  savedStorylines: 5,
  canonStorylines: 50,
  activeCanonBeats: 100,
});

export const BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS = Object.freeze({
  roster: 25,
  recentEvents: 5,
  recentStoryBeats: 5,
  savedStorylines: 5,
  canonStorylines: 8,
  activeCanonBeats: 12,
  participantNamesPerItem: 10,
  canonSummaryCodePoints: 1_000,
  legacySummaryCodePoints: 500,
  savedStorylineCodePoints: BACKSTAGE_SAVED_STORYLINE_EXCERPT_CODE_POINTS,
  serializedResultBytes: BACKSTAGE_UNIVERSE_READ_RESULT_LIMIT_BYTES,
});

export interface BackstageUniverseReadRosterEntry {
  name: string;
  overall: number;
}

export interface BackstageUniverseReadLegacyEntry {
  id: string;
  label: string | null;
  summary: string | null;
  createdAt: string;
}

export interface BackstageUniverseReadSavedStoryline {
  id: string;
  key: string;
  storylineExcerpt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackstageUniverseReadCanonStoryline {
  id: string;
  key: string;
  title: string;
  summary: string | null;
  status: BackstageCanonStorylineRecord['status'];
  participantNames: string[];
  version: number;
  universeRevision: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface BackstageUniverseReadCanonBeat {
  id: string;
  storylineId: string;
  storylineKey: string;
  sequence: number;
  kind: string;
  summary: string;
  occurredAt: string;
  participantNames: string[];
  eventId: string | null;
  supersedesBeatId: string | null;
  universeRevision: string;
  createdAt: string;
}

export interface BackstageUniverseReadOmittedItems {
  roster: number;
  recentEvents: number;
  recentStoryBeats: number;
  savedStorylines: number;
  canonStorylines: number;
  activeCanonBeats: number;
  participantNames: number;
}

export interface BackstageUniverseReadResult {
  universeId: string;
  source: 'postgresql';
  hasPersistedData: boolean;
  sourceQueryLimits: typeof BACKSTAGE_UNIVERSE_READ_SOURCE_LIMITS;
  responseLimits: typeof BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS;
  truncation: {
    truncated: boolean;
    sections: string[];
    omittedItems: BackstageUniverseReadOmittedItems;
  };
  snapshot: {
    roster: BackstageUniverseReadRosterEntry[];
    recentEvents: BackstageUniverseReadLegacyEntry[];
    recentStoryBeats: BackstageUniverseReadLegacyEntry[];
    savedStorylines: BackstageUniverseReadSavedStoryline[];
    canon: {
      revision: string;
      storylines: BackstageUniverseReadCanonStoryline[];
      activeBeats: BackstageUniverseReadCanonBeat[];
    };
  };
}

export interface BackstageUniverseContextReader {
  loadContext(
    universeId: string,
    options?: {
      statementTimeoutMs?: number;
      universeReadProjection?: boolean;
    }
  ): Promise<BackstageContext>;
}

export type BackstageNotionAuthorityResolver = (
  universeId: string
) => boolean | Promise<boolean>;

export interface ReadBackstageUniverseOptions {
  reader?: BackstageUniverseContextReader;
  authorityResolver?: BackstageNotionAuthorityResolver;
}

export interface BackstageStorylineSummaryReader {
  loadCanonStorylineSummary(
    universeId: string,
    storyKey: string,
    options?: { statementTimeoutMs?: number }
  ): Promise<BackstageCanonStorylineSummaryRecord | null>;
}

export interface ReadBackstageStorylineSummaryOptions {
  reader?: BackstageStorylineSummaryReader;
  authorityResolver?: BackstageNotionAuthorityResolver;
  offset?: number;
  expectedVersion?: number;
}

export interface BackstageStorylineSummaryReadResult {
  universeId: string;
  source: 'postgresql';
  pageCodePointLimit: typeof BACKSTAGE_STORYLINE_SUMMARY_PAGE_CODE_POINTS;
  storyline: {
    id: string;
    key: string;
    title: string;
    status: BackstageCanonStorylineRecord['status'];
    version: number;
    universeRevision: string;
    updatedAt: string;
  };
  summaryPage: {
    text: string | null;
    startCodePoint: number;
    endCodePointExclusive: number;
    totalCodePoints: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

export class BackstageStorylineSummaryReadRequestError extends Error {
  readonly code = 'GPT_ACCESS_VALIDATION_ERROR';

  constructor(message = 'The Backstage storyline summary read request is invalid.') {
    super(message);
    this.name = 'BackstageStorylineSummaryReadRequestError';
  }
}

function getBackstageReadRepository(
  operation: 'loadContext' | 'loadCanonStorylineSummary'
): PostgresBackstageBookerRepository {
  const getPool = typeof coreDb.getPool === 'function' ? coreDb.getPool : null;
  const pool = getPool?.() ?? null;
  if (!pool) {
    throw new BackstageBookerRepositoryUnavailableError(operation);
  }
  return createBackstageBookerRepository(pool);
}

function assertExactStorylineKey(storyKey: string): void {
  if (
    typeof storyKey !== 'string'
    || storyKey !== storyKey.trim()
    || storyKey.length === 0
    || Array.from(storyKey).length > 240
  ) {
    throw new BackstageStorylineSummaryReadRequestError();
  }
  for (let index = 0; index < storyKey.length; index += 1) {
    const codeUnit = storyKey.charCodeAt(index);
    if (codeUnit === 0) {
      throw new BackstageStorylineSummaryReadRequestError();
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailingCodeUnit = storyKey.charCodeAt(index + 1);
      if (!(trailingCodeUnit >= 0xdc00 && trailingCodeUnit <= 0xdfff)) {
        throw new BackstageStorylineSummaryReadRequestError();
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new BackstageStorylineSummaryReadRequestError();
    }
  }
}

function assertStorylineSummaryReadPagination(
  offset: number,
  expectedVersion: number | undefined
): void {
  if (
    !Number.isSafeInteger(offset)
    || offset < 0
    || offset > BACKSTAGE_STORYLINE_SUMMARY_MAX_CODE_POINTS
    || (
      expectedVersion !== undefined
      && (
        !Number.isSafeInteger(expectedVersion)
        || expectedVersion < 1
        || expectedVersion > 2_147_483_647
      )
    )
    || (offset > 0 && expectedVersion === undefined)
  ) {
    throw new BackstageStorylineSummaryReadRequestError();
  }
}

function toIsoTimestamp(value: Date | string, label: string): string {
  const timestamp = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  return timestamp.toISOString();
}

function truncateCodePoints(
  value: string,
  maximum: number,
  section: string,
  truncatedSections: Set<string>
): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maximum) {
    return value;
  }
  truncatedSections.add(section);
  return codePoints.slice(0, maximum).join('');
}

function projectRequiredText(
  value: string,
  label: string,
  maximum: number,
  section: string,
  truncatedSections: Set<string>
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return truncateCodePoints(normalized, maximum, section, truncatedSections);
}

function readFirstText(
  data: Record<string, unknown>,
  keys: readonly string[],
  maximum: number,
  section: string,
  truncatedSections: Set<string>
): string | null {
  for (const key of keys) {
    const candidate = data[key];
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      continue;
    }
    return truncateCodePoints(
      candidate.trim(),
      maximum,
      section,
      truncatedSections
    );
  }
  return null;
}

function assertUniverseIdentity(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new TypeError('Backstage universe read returned mixed universe data.');
  }
}

function mapCanonStoryline(
  record: BackstageCanonStorylineRecord,
  universeId: string,
  truncatedSections: Set<string>,
  omittedItems: BackstageUniverseReadOmittedItems
): BackstageUniverseReadCanonStoryline {
  assertUniverseIdentity(record.universeId, universeId);
  const participantNames = record.participantNames.slice(
    0,
    BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.participantNamesPerItem
  );
  const omittedParticipants = record.participantNames.length - participantNames.length;
  if (omittedParticipants > 0) {
    omittedItems.participantNames += omittedParticipants;
    truncatedSections.add('snapshot.canon.storylines.participantNames');
  }

  return {
    id: record.id,
    key: projectRequiredText(
      record.storyKey,
      'Backstage canon storyline key',
      240,
      'snapshot.canon.storylines.key',
      truncatedSections
    ),
    title: projectRequiredText(
      record.title,
      'Backstage canon storyline title',
      240,
      'snapshot.canon.storylines.title',
      truncatedSections
    ),
    summary: record.summary === null
      ? null
      : truncateCodePoints(
          record.summary,
          BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.canonSummaryCodePoints,
          'snapshot.canon.storylines.summary',
          truncatedSections
        ),
    status: record.status,
    participantNames,
    version: record.version,
    universeRevision: record.updatedRevision,
    createdAt: toIsoTimestamp(record.createdAt, 'Backstage canon storyline createdAt'),
    updatedAt: toIsoTimestamp(record.updatedAt, 'Backstage canon storyline updatedAt'),
    closedAt: record.closedAt === null
      ? null
      : toIsoTimestamp(record.closedAt, 'Backstage canon storyline closedAt'),
  };
}

function mapCanonBeat(
  record: BackstageCanonBeatRecord,
  universeId: string,
  truncatedSections: Set<string>,
  omittedItems: BackstageUniverseReadOmittedItems
): BackstageUniverseReadCanonBeat {
  assertUniverseIdentity(record.universeId, universeId);
  if (!/^[a-z][a-z0-9._:-]{0,63}$/u.test(record.kind)) {
    throw new TypeError('Backstage canon beat kind is invalid.');
  }
  const participantNames = record.participantNames.slice(
    0,
    BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.participantNamesPerItem
  );
  const omittedParticipants = record.participantNames.length - participantNames.length;
  if (omittedParticipants > 0) {
    omittedItems.participantNames += omittedParticipants;
    truncatedSections.add('snapshot.canon.activeBeats.participantNames');
  }

  return {
    id: record.id,
    storylineId: record.storylineId,
    storylineKey: projectRequiredText(
      record.storyKey,
      'Backstage canon beat storyline key',
      240,
      'snapshot.canon.activeBeats.storylineKey',
      truncatedSections
    ),
    sequence: record.sequence,
    kind: record.kind,
    summary: truncateCodePoints(
      record.summary,
      BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.canonSummaryCodePoints,
      'snapshot.canon.activeBeats.summary',
      truncatedSections
    ),
    occurredAt: toIsoTimestamp(record.occurredAt, 'Backstage canon beat occurredAt'),
    participantNames,
    eventId: record.eventId,
    supersedesBeatId: record.supersedesBeatId,
    universeRevision: record.revision,
    createdAt: toIsoTimestamp(record.createdAt, 'Backstage canon beat createdAt'),
  };
}

function hasPersistedBackstageData(context: BackstageContext): boolean {
  return context.roster.length > 0
    || context.events.length > 0
    || context.storyBeats.length > 0
    || context.storylines.length > 0
    || context.canonContext.revision !== '0'
    || context.canonContext.storylines.length > 0
    || context.canonContext.activeBeats.length > 0;
}

function buildBackstageUniverseReadResult(
  universeId: string,
  context: BackstageContext
): BackstageUniverseReadResult {
  assertUniverseIdentity(context.canonContext.universeId, universeId);
  const truncatedSections = new Set<string>();
  const omittedItems: BackstageUniverseReadOmittedItems = {
    roster: Math.max(
      0,
      context.roster.length - BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.roster
    ),
    recentEvents: 0,
    recentStoryBeats: 0,
    savedStorylines: 0,
    canonStorylines: Math.max(
      0,
      context.canonContext.storylines.length
        - BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.canonStorylines
    ),
    activeCanonBeats: Math.max(
      0,
      context.canonContext.activeBeats.length
        - BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.activeCanonBeats
    ),
    participantNames: 0,
  };
  if (omittedItems.roster > 0) {
    truncatedSections.add('snapshot.roster');
  }
  if (omittedItems.canonStorylines > 0) {
    truncatedSections.add('snapshot.canon.storylines');
  }
  if (omittedItems.activeCanonBeats > 0) {
    truncatedSections.add('snapshot.canon.activeBeats');
  }
  const omittedStorylineParticipants = context.canonContext.storylines
    .slice(BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.canonStorylines)
    .reduce((total, storyline) => total + storyline.participantNames.length, 0);
  const omittedBeatParticipants = context.canonContext.activeBeats
    .slice(
      0,
      Math.max(
        0,
        context.canonContext.activeBeats.length
          - BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.activeCanonBeats
      )
    )
    .reduce((total, beat) => total + beat.participantNames.length, 0);
  omittedItems.participantNames =
    omittedStorylineParticipants + omittedBeatParticipants;
  if (omittedStorylineParticipants > 0) {
    truncatedSections.add('snapshot.canon.storylines.participantNames');
  }
  if (omittedBeatParticipants > 0) {
    truncatedSections.add('snapshot.canon.activeBeats.participantNames');
  }

  const recentEvents = context.events
    .slice(0, BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.recentEvents)
    .map(event => {
    assertUniverseIdentity(event.universeId, universeId);
    return {
      id: event.id,
      label: readFirstText(
        event.data,
        ['name', 'title', 'eventName', 'showName'],
        240,
        'snapshot.recentEvents.label',
        truncatedSections
      ),
      summary: readFirstText(
        event.data,
        ['summary', 'description', 'result', 'notes'],
        BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.legacySummaryCodePoints,
        'snapshot.recentEvents.summary',
        truncatedSections
      ),
      createdAt: toIsoTimestamp(event.createdAt, 'Backstage event createdAt'),
    };
    });
  omittedItems.recentEvents = Math.max(0, context.events.length - recentEvents.length);
  if (omittedItems.recentEvents > 0) {
    truncatedSections.add('snapshot.recentEvents');
  }
  const recentStoryBeats = context.storyBeats
    .slice(-BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.recentStoryBeats)
    .map(beat => {
    assertUniverseIdentity(beat.universeId, universeId);
    return {
      id: beat.id,
      label: readFirstText(
        beat.data,
        ['title', 'name', 'kind', 'type'],
        240,
        'snapshot.recentStoryBeats.label',
        truncatedSections
      ),
      summary: readFirstText(
        beat.data,
        ['summary', 'description', 'beat', 'notes'],
        BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.legacySummaryCodePoints,
        'snapshot.recentStoryBeats.summary',
        truncatedSections
      ),
      createdAt: toIsoTimestamp(beat.createdAt, 'Backstage story beat createdAt'),
    };
    });
  omittedItems.recentStoryBeats = Math.max(
    0,
    context.storyBeats.length - recentStoryBeats.length
  );
  if (omittedItems.recentStoryBeats > 0) {
    truncatedSections.add('snapshot.recentStoryBeats');
  }
  const savedStorylines = context.storylines
    .slice(0, BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.savedStorylines)
    .map(storyline => {
    assertUniverseIdentity(storyline.universeId, universeId);
    const storylineProjection = projectBackstageSavedStorylineExcerpt(
      storyline.storyline
    );
    if (storylineProjection.truncated) {
      truncatedSections.add('snapshot.savedStorylines.storylineExcerpt');
    }
    return {
      id: storyline.id,
      key: projectRequiredText(
        storyline.storyKey,
        'Backstage saved storyline key',
        240,
        'snapshot.savedStorylines.key',
        truncatedSections
      ),
      storylineExcerpt: storylineProjection.storylineExcerpt,
      createdAt: toIsoTimestamp(
        storyline.createdAt,
        'Backstage saved storyline createdAt'
      ),
      updatedAt: toIsoTimestamp(
        storyline.updatedAt,
        'Backstage saved storyline updatedAt'
      ),
    };
    });
  omittedItems.savedStorylines = Math.max(
    0,
    context.storylines.length - savedStorylines.length
  );
  if (omittedItems.savedStorylines > 0) {
    truncatedSections.add('snapshot.savedStorylines');
  }
  const canonStorylines = context.canonContext.storylines
    .slice(0, BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.canonStorylines)
    .map(storyline => mapCanonStoryline(
      storyline,
      universeId,
      truncatedSections,
      omittedItems
    ));
  const activeCanonBeats = context.canonContext.activeBeats
    .slice(-BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.activeCanonBeats)
    .map(beat => mapCanonBeat(
      beat,
      universeId,
      truncatedSections,
      omittedItems
    ));
  const roster = context.roster
    .slice(0, BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS.roster)
    .map(wrestler => ({
      name: projectRequiredText(
        wrestler.name,
        'Backstage wrestler name',
        120,
        'snapshot.roster.name',
        truncatedSections
      ),
      overall: wrestler.overall,
    }));

  const buildResult = (): BackstageUniverseReadResult => ({
    universeId,
    source: 'postgresql',
    hasPersistedData: hasPersistedBackstageData(context),
    sourceQueryLimits: BACKSTAGE_UNIVERSE_READ_SOURCE_LIMITS,
    responseLimits: BACKSTAGE_UNIVERSE_READ_RESPONSE_LIMITS,
    truncation: {
      truncated: truncatedSections.size > 0,
      sections: [...truncatedSections].sort(),
      omittedItems: { ...omittedItems },
    },
    snapshot: {
      roster,
      recentEvents,
      recentStoryBeats,
      savedStorylines,
      canon: {
        revision: context.canonContext.revision,
        storylines: canonStorylines,
        activeBeats: activeCanonBeats,
      },
    },
  });

  const dropOldestOptionalItem = (): boolean => {
    if (recentEvents.length > 0) {
      recentEvents.pop();
      omittedItems.recentEvents += 1;
      truncatedSections.add('snapshot.recentEvents');
      return true;
    }
    if (recentStoryBeats.length > 0) {
      recentStoryBeats.shift();
      omittedItems.recentStoryBeats += 1;
      truncatedSections.add('snapshot.recentStoryBeats');
      return true;
    }
    if (savedStorylines.length > 0) {
      savedStorylines.pop();
      omittedItems.savedStorylines += 1;
      truncatedSections.add('snapshot.savedStorylines');
      return true;
    }
    if (activeCanonBeats.length > 0) {
      const [omittedBeat] = activeCanonBeats.splice(0, 1);
      omittedItems.activeCanonBeats += 1;
      truncatedSections.add('snapshot.canon.activeBeats');
      if (omittedBeat && omittedBeat.participantNames.length > 0) {
        omittedItems.participantNames += omittedBeat.participantNames.length;
        truncatedSections.add('snapshot.canon.activeBeats.participantNames');
      }
      return true;
    }
    if (canonStorylines.length > 0) {
      const omittedStoryline = canonStorylines.pop();
      omittedItems.canonStorylines += 1;
      truncatedSections.add('snapshot.canon.storylines');
      if (omittedStoryline && omittedStoryline.participantNames.length > 0) {
        omittedItems.participantNames += omittedStoryline.participantNames.length;
        truncatedSections.add('snapshot.canon.storylines.participantNames');
      }
      return true;
    }
    return false;
  };

  let result = buildResult();
  while (
    Buffer.byteLength(JSON.stringify(result), 'utf8')
      > BACKSTAGE_UNIVERSE_READ_RESULT_LIMIT_BYTES
  ) {
    if (!dropOldestOptionalItem()) {
      throw new TypeError('Backstage universe read result could not be bounded safely.');
    }
    result = buildResult();
  }
  return result;
}

/**
 * Read one exact Backstage universe directly from PostgreSQL. This path never
 * falls back to process memory or overlays uncommitted service state.
 */
export async function readBackstageUniverse(
  universeId: string,
  options: ReadBackstageUniverseOptions = {}
): Promise<BackstageUniverseReadResult> {
  if (
    typeof universeId !== 'string'
    || universeId !== universeId.trim()
    || !BACKSTAGE_UNIVERSE_ID_PATTERN.test(universeId)
  ) {
    throw new TypeError('universeId must be a valid Backstage universe identifier.');
  }
  const authorityResolver = options.authorityResolver
    ?? isBackstageNotionAuthorityEnforced;
  if (await authorityResolver(universeId)) {
    throw new BackstageNotionAuthorityReadQuarantinedError(universeId);
  }

  const reader = options.reader ?? getBackstageReadRepository('loadContext');
  let context: BackstageContext;
  try {
    context = await reader.loadContext(universeId, {
      statementTimeoutMs: BACKSTAGE_UNIVERSE_READ_DB_STATEMENT_TIMEOUT_MS,
      universeReadProjection: true,
    });
  } catch (error) {
    if (isBackstageBookerLegacyReadQuarantinedError(error)) {
      throw new BackstageNotionAuthorityReadQuarantinedError(universeId);
    }
    throw error;
  }
  return buildBackstageUniverseReadResult(universeId, context);
}

/**
 * Read one exact durable canon storyline summary in fixed Unicode-code-point
 * pages. Continuation pages require a version fence so callers cannot combine
 * text from two different storyline revisions.
 */
export async function readBackstageStorylineSummary(
  universeId: string,
  storyKey: string,
  options: ReadBackstageStorylineSummaryOptions = {}
): Promise<BackstageStorylineSummaryReadResult> {
  if (
    typeof universeId !== 'string'
    || universeId !== universeId.trim()
    || !BACKSTAGE_UNIVERSE_ID_PATTERN.test(universeId)
  ) {
    throw new BackstageStorylineSummaryReadRequestError();
  }
  assertExactStorylineKey(storyKey);
  const offset = options.offset ?? 0;
  assertStorylineSummaryReadPagination(offset, options.expectedVersion);
  const authorityResolver = options.authorityResolver
    ?? isBackstageNotionAuthorityEnforced;
  if (await authorityResolver(universeId)) {
    throw new BackstageNotionAuthorityReadQuarantinedError(universeId);
  }

  const reader = options.reader
    ?? getBackstageReadRepository('loadCanonStorylineSummary');
  let storyline: BackstageCanonStorylineSummaryRecord | null;
  try {
    storyline = await reader.loadCanonStorylineSummary(
      universeId,
      storyKey,
      { statementTimeoutMs: BACKSTAGE_UNIVERSE_READ_DB_STATEMENT_TIMEOUT_MS }
    );
  } catch (error) {
    if (isBackstageBookerLegacyReadQuarantinedError(error)) {
      throw new BackstageNotionAuthorityReadQuarantinedError(universeId);
    }
    throw error;
  }
  const projection = projectBackstageStorylineSummaryPage(
    universeId,
    storyKey,
    storyline,
    { offset, expectedVersion: options.expectedVersion }
  );
  if (!projection.ok) {
    switch (projection.reason) {
      case 'not-found':
        throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_NOT_FOUND');
      case 'offset-out-of-range':
        throw new BackstageStorylineSummaryReadRequestError();
      case 'scope-mismatch':
        throw new TypeError(
          'Backstage storyline summary read returned mixed scope data.'
        );
      case 'version-conflict':
        throw new BackstageCanonDomainError(
          'BACKSTAGE_STORYLINE_VERSION_CONFLICT'
        );
    }
  }
  if (!storyline) {
    throw new TypeError(
      'Backstage storyline summary projection accepted a missing record.'
    );
  }

  return {
    universeId,
    source: 'postgresql',
    pageCodePointLimit: BACKSTAGE_STORYLINE_SUMMARY_PAGE_CODE_POINTS,
    storyline: {
      id: storyline.id,
      key: storyline.storyKey,
      title: storyline.title,
      status: storyline.status,
      version: storyline.version,
      universeRevision: storyline.updatedRevision,
      updatedAt: toIsoTimestamp(
        storyline.updatedAt,
        'Backstage canon storyline updatedAt'
      ),
    },
    summaryPage: projection.summaryPage,
  };
}
