export const DEFAULT_BACKSTAGE_UNIVERSE_ID = "legacy" as const;

export const BACKSTAGE_CANON_UTC_TIMESTAMP_PATTERN_SOURCE =
  "^(?!0000-)(?:(?:[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8])))|(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:0[48]|[2468][048]|[13579][26])00)-02-29))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?Z$";

const backstageCanonUtcTimestampPattern = new RegExp(
  BACKSTAGE_CANON_UTC_TIMESTAMP_PATTERN_SOURCE,
  "u"
);

/** Return whether a value is a supported, calendar-valid UTC canon timestamp. */
export function isValidBackstageCanonUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && backstageCanonUtcTimestampPattern.test(value);
}

export const BACKSTAGE_BOOKER_ACTIONS = [
  "bookEvent",
  "updateRoster",
  "trackStoryline",
  "simulateMatch",
  "generateBooking",
  "generateBookingWithHRC",
  "saveStoryline",
  "upsertStoryline",
  "appendCanonBeat"
] as const;

export type BackstageBookerAction = (typeof BACKSTAGE_BOOKER_ACTIONS)[number];
export type BackstageUniverseId = string;
export type BackstageMutationId = string;
export type BackstageUniverseRevision = string;
export type BackstageJsonValue =
  | string
  | number
  | boolean
  | null
  | BackstageJsonValue[]
  | BackstageJsonObject;

export interface BackstageJsonObject {
  [key: string]: BackstageJsonValue;
}

export interface BackstageWrestler {
  name: string;
  overall: number;
}

export interface BackstageHrcResult {
  fidelity: number;
  resilience: number;
  verdict: string;
}

export interface BackstageDurablePersistence {
  status: "durable";
  durable: true;
  backend: "postgresql";
  degraded: false;
}

export interface BackstageNonDurablePersistence {
  status: "non_durable";
  durable: false;
  backend: "process-memory";
  degraded: true;
  reason: "database_unavailable" | "database_write_failed";
}

export interface BackstageUnknownPersistence {
  status: "unknown";
  durable: null;
  backend: "postgresql";
  degraded: true;
  reason: "commit_outcome_unknown";
}

export type BackstagePersistence =
  | BackstageDurablePersistence
  | BackstageNonDurablePersistence
  | BackstageUnknownPersistence;

export interface BackstageMatchInput {
  wrestler1: string;
  wrestler2: string;
  matchType: string;
  kayfabeMode?: boolean;
}

export interface BackstageMatchResultBase {
  match: string;
  interference: string | null;
  rating: string;
}

export interface BackstageKayfabeResult extends BackstageMatchResultBase {
  result: string;
  via: string;
}

export interface BackstageRealResult extends BackstageMatchResultBase {
  winner: string;
  loser: string;
  probability: Record<string, string>;
}

export type BackstageMatchResult = BackstageKayfabeResult | BackstageRealResult;

export interface BackstageBookEventRequest {
  universeId?: BackstageUniverseId;
  event: BackstageJsonObject;
}

export interface BackstageBookEventResponse {
  universeId: BackstageUniverseId;
  eventId: string;
  persistence: BackstagePersistence;
}

export interface BackstageUpdateRosterRequest {
  universeId?: BackstageUniverseId;
  wrestlers: BackstageWrestler[];
}

export interface BackstageUpdateRosterResponse {
  universeId: BackstageUniverseId;
  roster: BackstageWrestler[];
  persistence: BackstagePersistence;
}

export interface BackstageTrackStorylineRequest {
  universeId?: BackstageUniverseId;
  beat: BackstageJsonObject;
}

export interface BackstageTrackStorylineResponse {
  universeId: BackstageUniverseId;
  beats: BackstageJsonObject[];
  persistence: BackstagePersistence;
}

export interface BackstageSimulateMatchRequest {
  universeId?: BackstageUniverseId;
  match: BackstageMatchInput;
  rosters?: BackstageWrestler[];
  winProbModifier?: number;
}

export interface BackstageSimulateMatchResponse {
  universeId: BackstageUniverseId;
  result: BackstageMatchResult;
  hrc: BackstageHrcResult;
}

export interface BackstageGenerateBookingRequest {
  universeId?: BackstageUniverseId;
  prompt: string;
}

export interface BackstageGenerateBookingStructuredResponse {
  universeId: BackstageUniverseId;
  storyline: string;
}

/** @deprecated Prefer the structured response when the caller supports it. */
export type BackstageGenerateBookingResponse =
  | string
  | BackstageGenerateBookingStructuredResponse;

export type BackstageGenerateBookingWithHrcRequest = BackstageGenerateBookingRequest;

export interface BackstageGenerateBookingWithHrcResponse
  extends BackstageGenerateBookingStructuredResponse {
  hrc: BackstageHrcResult;
}

export interface BackstageSaveStorylineRequest {
  universeId?: BackstageUniverseId;
  key: string;
  storyline: string;
}

export interface BackstageSaveStorylineResponse {
  universeId: BackstageUniverseId;
  key: string;
  saved: true | null;
  persistence: BackstagePersistence;
}

export type BackstageStorylineStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "cancelled";

export interface BackstageStorylineInput {
  key: string;
  title: string;
  summary: string | null;
  status: BackstageStorylineStatus;
  participantNames: string[];
}

export interface BackstageStorylineModel extends BackstageStorylineInput {
  id: string;
  version: number;
  universeRevision: BackstageUniverseRevision;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface BackstageCanonBeatInput {
  kind: string;
  summary: string;
  occurredAt: string;
  participantNames: string[];
  eventId?: string;
  supersedesBeatId?: string;
}

export interface BackstageCanonBeatModel {
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
  universeRevision: BackstageUniverseRevision;
  createdAt: string;
}

export type BackstageCanonPersistence =
  | BackstageDurablePersistence
  | BackstageUnknownPersistence;

export interface BackstageUpsertStorylineRequest {
  universeId: BackstageUniverseId;
  mutationId: BackstageMutationId;
  expectedVersion: number;
  storyline: BackstageStorylineInput;
}

export interface BackstageUpsertStorylineDurableResponse {
  universeId: BackstageUniverseId;
  mutationId: BackstageMutationId;
  applied: true;
  universeRevision: BackstageUniverseRevision;
  storyline: BackstageStorylineModel;
  persistence: BackstageDurablePersistence;
}

export interface BackstageUpsertStorylineUnknownResponse {
  universeId: BackstageUniverseId;
  mutationId: BackstageMutationId;
  applied: null;
  universeRevision: null;
  storyline: null;
  persistence: BackstageUnknownPersistence;
}

export type BackstageUpsertStorylineResponse =
  | BackstageUpsertStorylineDurableResponse
  | BackstageUpsertStorylineUnknownResponse;

export interface BackstageAppendCanonBeatRequest {
  universeId: BackstageUniverseId;
  mutationId: BackstageMutationId;
  storylineKey: string;
  expectedVersion: number;
  beat: BackstageCanonBeatInput;
  nextStatus?: BackstageStorylineStatus;
}

export interface BackstageAppendCanonBeatDurableResponse {
  universeId: BackstageUniverseId;
  mutationId: BackstageMutationId;
  applied: true;
  universeRevision: BackstageUniverseRevision;
  storyline: BackstageStorylineModel;
  beat: BackstageCanonBeatModel;
  persistence: BackstageDurablePersistence;
}

export interface BackstageAppendCanonBeatUnknownResponse {
  universeId: BackstageUniverseId;
  mutationId: BackstageMutationId;
  applied: null;
  universeRevision: null;
  storyline: null;
  beat: null;
  persistence: BackstageUnknownPersistence;
}

export type BackstageAppendCanonBeatResponse =
  | BackstageAppendCanonBeatDurableResponse
  | BackstageAppendCanonBeatUnknownResponse;

export interface BackstageBookerActionInputMap {
  bookEvent: BackstageBookEventRequest;
  updateRoster: BackstageUpdateRosterRequest;
  trackStoryline: BackstageTrackStorylineRequest;
  simulateMatch: BackstageSimulateMatchRequest;
  generateBooking: BackstageGenerateBookingRequest;
  generateBookingWithHRC: BackstageGenerateBookingWithHrcRequest;
  saveStoryline: BackstageSaveStorylineRequest;
  upsertStoryline: BackstageUpsertStorylineRequest;
  appendCanonBeat: BackstageAppendCanonBeatRequest;
}

export interface BackstageBookerActionOutputMap {
  bookEvent: BackstageBookEventResponse;
  updateRoster: BackstageUpdateRosterResponse;
  trackStoryline: BackstageTrackStorylineResponse;
  simulateMatch: BackstageSimulateMatchResponse;
  generateBooking: BackstageGenerateBookingResponse;
  generateBookingWithHRC: BackstageGenerateBookingWithHrcResponse;
  saveStoryline: BackstageSaveStorylineResponse;
  upsertStoryline: BackstageUpsertStorylineResponse;
  appendCanonBeat: BackstageAppendCanonBeatResponse;
}

export function isBackstageBookerAction(value: string): value is BackstageBookerAction {
  return (BACKSTAGE_BOOKER_ACTIONS as readonly string[]).includes(value);
}
