import { promises as fs } from 'fs';
import path from 'path';
import {
  getDagArtifactPayloadByReference,
  upsertDagArtifact
} from '@core/db/repositories/dagArtifactRepository.js';
import type { DAGResult } from './dagNode.js';

export interface DagArtifactWriteRequest {
  runId: string;
  nodeId: string;
  attempt: number;
  artifactKind: 'result' | 'failure' | 'dependency';
  payload: unknown;
}

export interface DagArtifactStore {
  /**
   * Persist one DAG artifact payload and return its stable reference.
   * Purpose: move large DAG outputs out of queue payloads and into shared storage.
   * Inputs/outputs: accepts run/node identifiers plus payload and returns a relative artifact reference.
   * Edge case behavior: throws when the payload cannot be serialized or the artifact path is unsafe.
   */
  writeArtifact(request: DagArtifactWriteRequest): Promise<string>;

  /**
   * Load one previously stored artifact payload.
   * Purpose: hydrate artifact-backed DAG dependencies before worker execution.
   * Inputs/outputs: accepts one artifact reference and returns the parsed JSON payload.
   * Edge case behavior: throws when the reference is invalid, escapes the base directory, or contains invalid JSON.
   */
  readArtifact<T = unknown>(artifactReference: string): Promise<T>;
}

const DEFAULT_TRINITY_ARTIFACT_DIRECTORY = path.join('tmp', 'trinity-artifacts');

type ArtifactReferenceOutput = {
  artifact: string;
};

export type DagArtifactStoreBackend = 'filesystem' | 'database';

function normalizeArtifactSegment(value: string, fallbackValue: string): string {
  const normalizedValue = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
  return normalizedValue.length > 0 ? normalizedValue : fallbackValue;
}

/**
 * Resolve the DAG artifact store directory from runtime bindings.
 * Purpose: prefer a Railway volume path when available while keeping a local fallback for tests and development.
 * Inputs/outputs: accepts an optional environment object and returns an absolute base directory path.
 * Edge case behavior: falls back to a repo-local temp directory when no explicit path is configured.
 */
export function resolveDagArtifactStoreDirectory(
  env: NodeJS.ProcessEnv = process.env
): string {
  const explicitDirectory = env.TRINITY_ARTIFACT_STORE_DIR?.trim();
  if (explicitDirectory) {
    return path.resolve(explicitDirectory);
  }

  const railwayVolumePath = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (railwayVolumePath) {
    return path.resolve(railwayVolumePath, 'trinity-artifacts');
  }

  return path.resolve(process.cwd(), DEFAULT_TRINITY_ARTIFACT_DIRECTORY);
}

/**
 * Resolve which DAG artifact backend should be used for the current runtime.
 * Purpose: keep local development on filesystem storage while forcing cross-service-safe storage on Railway.
 * Inputs/outputs: accepts an optional environment object and returns the normalized backend name.
 * Edge case behavior: invalid overrides are ignored and fall back to Railway-aware defaults.
 */
export function resolveDagArtifactStoreBackend(
  env: NodeJS.ProcessEnv = process.env
): DagArtifactStoreBackend {
  const explicitBackend = env.TRINITY_ARTIFACT_STORE_BACKEND?.trim().toLowerCase();

  //audit Assumption: explicit backend overrides should win when operators set them intentionally; failure risk: deployments silently use the wrong backend; expected invariant: recognized overrides map directly to a supported backend; handling strategy: honor only known values and ignore invalid overrides.
  if (explicitBackend === 'filesystem' || explicitBackend === 'database') {
    return explicitBackend;
  }

  //audit Assumption: Railway DAG execution spans multiple services that need shared artifact state; failure risk: filesystem artifacts become service-local and break dependency hydration; expected invariant: Railway defaults to shared storage; handling strategy: promote the database backend whenever the Railway runtime marker is present.
  if (env.RAILWAY_ENVIRONMENT?.trim()) {
    return 'database';
  }

  return 'filesystem';
}

/**
 * Build a minimal queue-safe output wrapper for one artifact reference.
 * Purpose: keep queue payloads small while preserving the artifact lookup handle.
 * Inputs/outputs: accepts one artifact reference and returns the queue-safe output wrapper.
 * Edge case behavior: always returns a plain JSON object.
 */
export function createArtifactReferenceOutput(
  artifactReference: string
): ArtifactReferenceOutput {
  return { artifact: artifactReference };
}

/**
 * Extract one artifact reference from a DAG result or queue-safe output wrapper.
 * Purpose: centralize artifact-ref detection across queue writers and worker readers.
 * Inputs/outputs: accepts a DAG result-like object and returns its artifact reference or `null`.
 * Edge case behavior: ignores malformed or empty artifact strings.
 */
export function extractArtifactReference(
  result: Pick<DAGResult, 'artifactRef' | 'output'>
): string | null {
  if (typeof result.artifactRef === 'string' && result.artifactRef.trim().length > 0) {
    return result.artifactRef.trim();
  }

  if (
    result.output &&
    typeof result.output === 'object' &&
    !Array.isArray(result.output) &&
    typeof (result.output as { artifact?: unknown }).artifact === 'string'
  ) {
    const artifactReference = (result.output as { artifact: string }).artifact.trim();
    return artifactReference.length > 0 ? artifactReference : null;
  }

  return null;
}

function normalizeArtifactPayload(payload: unknown): unknown {
  return payload === undefined ? null : payload;
}

class FileSystemDagArtifactStore implements DagArtifactStore {
  constructor(private readonly baseDirectory: string) {}

  async writeArtifact(request: DagArtifactWriteRequest): Promise<string> {
    const normalizedRunId = normalizeArtifactSegment(request.runId, 'run');
    const normalizedNodeId = normalizeArtifactSegment(request.nodeId, 'node');
    const normalizedAttempt = Math.max(1, Math.trunc(request.attempt));
    const normalizedArtifactKind = normalizeArtifactSegment(request.artifactKind, 'artifact');
    const artifactReference = path.posix.join(
      'trinity',
      'runs',
      normalizedRunId,
      normalizedNodeId,
      `attempt-${normalizedAttempt}`,
      `${normalizedArtifactKind}.json`
    );
    const absoluteArtifactPath = this.resolveArtifactPath(artifactReference);
    const serializedPayload = JSON.stringify(normalizeArtifactPayload(request.payload), null, 2);

    //audit Assumption: DAG artifacts must be JSON-serializable so queue workers can restore them deterministically; failure risk: large cyclic payloads break dependency hydration and resume checkpoints; expected invariant: every stored artifact serializes to JSON text; handling strategy: fail fast before touching the filesystem.
    if (serializedPayload === undefined) {
      throw new Error(
        `Artifact payload for run "${request.runId}" node "${request.nodeId}" could not be serialized.`
      );
    }

    await fs.mkdir(path.dirname(absoluteArtifactPath), { recursive: true });
    await fs.writeFile(absoluteArtifactPath, serializedPayload, 'utf8');
    return artifactReference;
  }

  async readArtifact<T = unknown>(artifactReference: string): Promise<T> {
    const absoluteArtifactPath = this.resolveArtifactPath(artifactReference);
    const serializedPayload = await fs.readFile(absoluteArtifactPath, 'utf8');

    try {
      return JSON.parse(serializedPayload) as T;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Artifact "${artifactReference}" contains invalid JSON: ${errorMessage}`
      );
    }
  }

  private resolveArtifactPath(artifactReference: string): string {
    const sanitizedReference = artifactReference.trim();
    const referenceSegments = sanitizedReference.split('/').filter(Boolean);
    const resolvedBaseDirectory = path.resolve(this.baseDirectory);
    const resolvedArtifactPath = path.resolve(
      resolvedBaseDirectory,
      ...referenceSegments
    );

    //audit Assumption: artifact references may come from persisted queue payloads and must never escape the configured store directory; failure risk: crafted references read or overwrite arbitrary filesystem paths; expected invariant: resolved artifact paths stay within `baseDirectory`; handling strategy: reject any reference that leaves the artifact root.
    if (
      !resolvedArtifactPath.startsWith(`${resolvedBaseDirectory}${path.sep}`) &&
      resolvedArtifactPath !== resolvedBaseDirectory
    ) {
      throw new Error(`Artifact reference "${artifactReference}" is outside the artifact store root.`);
    }

    return resolvedArtifactPath;
  }
}

class DatabaseDagArtifactStore implements DagArtifactStore {
  async writeArtifact(request: DagArtifactWriteRequest): Promise<string> {
    const normalizedRunId = normalizeArtifactSegment(request.runId, 'run');
    const normalizedNodeId = normalizeArtifactSegment(request.nodeId, 'node');
    const normalizedAttempt = Math.max(1, Math.trunc(request.attempt));
    const normalizedArtifactKind = normalizeArtifactSegment(request.artifactKind, 'artifact');
    const artifactReference = path.posix.join(
      'trinity',
      'runs',
      normalizedRunId,
      normalizedNodeId,
      `attempt-${normalizedAttempt}`,
      `${normalizedArtifactKind}.json`
    );

    await upsertDagArtifact({
      artifactReference,
      runId: normalizedRunId,
      nodeId: normalizedNodeId,
      attempt: normalizedAttempt,
      artifactKind: normalizedArtifactKind,
      payload: normalizeArtifactPayload(request.payload),
      createdAt: new Date().toISOString()
    });

    return artifactReference;
  }

  async readArtifact<T = unknown>(artifactReference: string): Promise<T> {
    const artifactPayload = await getDagArtifactPayloadByReference(artifactReference);

    //audit Assumption: artifact references in queued DAG payloads should already exist before workers hydrate them; failure risk: workers proceed with missing dependency state and produce invalid outputs; expected invariant: referenced artifacts are present in shared storage; handling strategy: fail fast when the artifact row is missing.
    if (artifactPayload === null) {
      throw new Error(`Artifact "${artifactReference}" was not found in shared storage.`);
    }

    return artifactPayload as T;
  }
}

/**
 * Create the default DAG artifact store implementation.
 * Purpose: centralize artifact-store construction so callers share one resolution strategy.
 * Inputs/outputs: accepts an optional environment object and returns a filesystem-backed artifact store.
 * Edge case behavior: defaults to a repo-local temp directory when no Railway volume is configured.
 */
export function createDagArtifactStore(
  env: NodeJS.ProcessEnv = process.env
): DagArtifactStore {
  const artifactStoreBackend = resolveDagArtifactStoreBackend(env);

  //audit Assumption: Railway services require a cross-service artifact backend while local development benefits from filesystem simplicity; failure risk: the wrong backend breaks distributed DAG hydration or adds unnecessary infrastructure coupling locally; expected invariant: backend selection follows the resolved runtime strategy; handling strategy: branch once here and keep callers backend-agnostic.
  if (artifactStoreBackend === 'database') {
    return new DatabaseDagArtifactStore();
  }

  return new FileSystemDagArtifactStore(resolveDagArtifactStoreDirectory(env));
}

/**
 * Replace inline dependency outputs with artifact references for queue persistence.
 * Purpose: keep queued DAG payloads compact while preserving enough information for worker hydration.
 * Inputs/outputs: accepts dependency results plus an artifact store and returns queue-safe DAG results.
 * Edge case behavior: reuses existing artifact references instead of writing duplicate artifacts.
 */
export async function persistDagDependencyArtifactsForQueue(params: {
  artifactStore: DagArtifactStore;
  runId: string;
  dependencyResults: Record<string, DAGResult>;
}): Promise<Record<string, DAGResult>> {
  const queueSafeEntries = await Promise.all(
    Object.entries(params.dependencyResults).map(async ([dependencyNodeId, dependencyResult]) => {
      const existingArtifactReference = extractArtifactReference(dependencyResult);
      const artifactReference =
        existingArtifactReference ??
        await params.artifactStore.writeArtifact({
          runId: params.runId,
          nodeId: dependencyNodeId,
          attempt: 1,
          artifactKind: dependencyResult.status === 'failed' ? 'failure' : 'dependency',
          payload: dependencyResult.output
        });

      return [
        dependencyNodeId,
        {
          ...dependencyResult,
          artifactRef: artifactReference,
          output: createArtifactReferenceOutput(artifactReference)
        } satisfies DAGResult
      ] as const;
    })
  );

  return Object.fromEntries(queueSafeEntries);
}

/**
 * Hydrate artifact-backed dependency results before worker execution.
 * Purpose: restore full dependency outputs from artifact references for prompt construction and agent logic.
 * Inputs/outputs: accepts queue-safe dependency results plus an artifact store and returns execution-ready results.
 * Edge case behavior: leaves inline dependency outputs unchanged when no artifact reference exists.
 */
export async function restoreDagDependencyArtifactsForExecution(params: {
  artifactStore: DagArtifactStore;
  dependencyResults: Record<string, DAGResult>;
}): Promise<Record<string, DAGResult>> {
  const hydratedEntries = await Promise.all(
    Object.entries(params.dependencyResults).map(async ([dependencyNodeId, dependencyResult]) => {
      const artifactReference = extractArtifactReference(dependencyResult);
      if (!artifactReference) {
        return [dependencyNodeId, dependencyResult] as const;
      }

      const hydratedOutput = await params.artifactStore.readArtifact(artifactReference);

      return [
        dependencyNodeId,
        {
          ...dependencyResult,
          artifactRef: artifactReference,
          output: hydratedOutput
        } satisfies DAGResult
      ] as const;
    })
  );

  return Object.fromEntries(hydratedEntries);
}
