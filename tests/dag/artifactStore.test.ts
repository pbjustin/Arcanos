import { describe, expect, it } from '@jest/globals';
import type { DAGResult } from '../../src/dag/dagNode.js';
import {
  createArtifactReferenceOutput,
  extractArtifactReference,
  persistDagDependencyArtifactsForQueue,
  resolveDagArtifactStoreBackend,
  restoreDagDependencyArtifactsForExecution,
  type DagArtifactStore,
  type DagArtifactWriteRequest
} from '../../src/dag/artifactStore.js';

class InMemoryDagArtifactStore implements DagArtifactStore {
  private readonly payloadsByReference = new Map<string, unknown>();

  async writeArtifact(request: DagArtifactWriteRequest): Promise<string> {
    const artifactReference = `trinity/runs/${request.runId}/${request.nodeId}/attempt-${request.attempt}/${request.artifactKind}.json`;
    this.payloadsByReference.set(artifactReference, request.payload);
    return artifactReference;
  }

  async readArtifact<T = unknown>(artifactReference: string): Promise<T> {
    return this.payloadsByReference.get(artifactReference) as T;
  }
}

describe('artifact-backed DAG dependency helpers', () => {
  it('replaces inline dependency outputs with artifact references and restores them later', async () => {
    const artifactStore = new InMemoryDagArtifactStore();
    const dependencyResults: Record<string, DAGResult> = {
      planner: {
        nodeId: 'planner',
        status: 'success',
        output: {
          summary: 'Plan the work',
          steps: ['research', 'build', 'audit']
        }
      }
    };

    const queueSafeResults = await persistDagDependencyArtifactsForQueue({
      artifactStore,
      runId: 'dag-1',
      dependencyResults
    });
    const hydratedResults = await restoreDagDependencyArtifactsForExecution({
      artifactStore,
      dependencyResults: queueSafeResults
    });

    expect(queueSafeResults.planner?.artifactRef).toBe(
      'trinity/runs/dag-1/planner/attempt-1/dependency.json'
    );
    expect(queueSafeResults.planner?.output).toEqual(
      createArtifactReferenceOutput('trinity/runs/dag-1/planner/attempt-1/dependency.json')
    );
    expect(hydratedResults.planner?.output).toEqual({
      summary: 'Plan the work',
      steps: ['research', 'build', 'audit']
    });
  });

  it('extracts artifact references from either the explicit field or the queue-safe output wrapper', () => {
    expect(
      extractArtifactReference({
        nodeId: 'node-1',
        status: 'success',
        output: { summary: 'ok' },
        artifactRef: 'trinity/runs/dag-1/node-1/attempt-1/result.json'
      })
    ).toBe('trinity/runs/dag-1/node-1/attempt-1/result.json');

    expect(
      extractArtifactReference({
        nodeId: 'node-2',
        status: 'success',
        output: createArtifactReferenceOutput('trinity/runs/dag-1/node-2/attempt-1/result.json')
      })
    ).toBe('trinity/runs/dag-1/node-2/attempt-1/result.json');
  });

  it('defaults Railway runtimes to the shared database artifact backend', () => {
    expect(resolveDagArtifactStoreBackend({
      RAILWAY_ENVIRONMENT: 'production'
    } as NodeJS.ProcessEnv)).toBe('database');

    expect(resolveDagArtifactStoreBackend({
      RAILWAY_ENVIRONMENT: 'production',
      TRINITY_ARTIFACT_STORE_BACKEND: 'filesystem'
    } as NodeJS.ProcessEnv)).toBe('filesystem');
  });
});
