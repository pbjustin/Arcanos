import { jest } from '@jest/globals';

const actualCore = await import('../src/shared/gaming/gamingArchiveResourceCore.js');
const actualGrounding = await import('../src/shared/gaming/gamingGrounding.js');
const mockResolveArchive = jest.fn(actualCore.resolveGamingArchiveResourceCore);
const mockEvidenceError = jest.fn(actualGrounding.createGamingSuppliedGuideEvidenceError);
const mockExecutionOutcome = jest.fn(actualGrounding.resolveGamingExecutionOutcome);

jest.unstable_mockModule('../src/shared/gaming/gamingArchiveResourceCore.js', () => ({
  ...actualCore,
  resolveGamingArchiveResourceCore: mockResolveArchive
}));
jest.unstable_mockModule('../src/shared/gaming/gamingGrounding.js', () => ({
  ...actualGrounding,
  createGamingSuppliedGuideEvidenceError: mockEvidenceError,
  resolveGamingExecutionOutcome: mockExecutionOutcome
}));
const { runGamingArchiveGroundingPreview } = await import('../src/shared/gaming/gamingArchivePreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_ARCHIVE_GROUNDING_CONTRACT_INVALID';

describe('sealed Gaming Archive and grounding component proof', () => {
  beforeEach(() => {
    mockResolveArchive.mockReset().mockImplementation(actualCore.resolveGamingArchiveResourceCore);
    mockEvidenceError.mockReset().mockImplementation(actualGrounding.createGamingSuppliedGuideEvidenceError);
    mockExecutionOutcome.mockReset().mockImplementation(actualGrounding.resolveGamingExecutionOutcome);
  });

  it('executes real resolver and grounding cores against only fixed in-memory fixtures', async () => {
    await expect(runGamingArchiveGroundingPreview()).resolves.toBeUndefined();
    expect(mockResolveArchive).toHaveBeenCalledTimes(9);
    expect(mockEvidenceError).toHaveBeenCalledWith(expect.objectContaining({
      groundingStatus: 'grounded', fetchedSourceCount: 1,
      selectedChunkCount: 1, groundedInSuppliedEvidence: true
    }));
    expect(mockEvidenceError).toHaveBeenCalledWith(expect.objectContaining({
      groundingStatus: 'unavailable', fetchedSourceCount: 0,
      selectedChunkCount: 0, groundedInSuppliedEvidence: false
    }));
  });

  it('fails closed when the resolver returns no success evidence', async () => {
    mockResolveArchive.mockResolvedValueOnce(null);
    await expect(runGamingArchiveGroundingPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when the core stops rejecting ambiguous documents', async () => {
    mockResolveArchive.mockImplementation(async (...args) => {
      try {
        return await actualCore.resolveGamingArchiveResourceCore(...args);
      } catch (error) {
        if (error instanceof actualCore.GamingArchiveResolutionError && error.reason === 'AMBIGUOUS_DOCUMENTS') {
          return null;
        }
        throw error;
      }
    });
    await expect(runGamingArchiveGroundingPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when a pre-provider evidence rejection is bypassed', async () => {
    mockEvidenceError.mockReturnValue(null);
    await expect(runGamingArchiveGroundingPreview()).rejects.toThrow(FAILURE);
  });

  it('fails closed when fallback execution is reported as completed', async () => {
    mockExecutionOutcome.mockReturnValue('completed');
    await expect(runGamingArchiveGroundingPreview()).rejects.toThrow(FAILURE);
  });

  it('replaces unexpected dependency failures with a fixed cause-free error', async () => {
    mockResolveArchive.mockRejectedValueOnce(new Error('private-fixture-sentinel'));
    await expect(runGamingArchiveGroundingPreview()).rejects.toMatchObject({ message: FAILURE });
    mockResolveArchive.mockRejectedValueOnce(new Error('private-fixture-sentinel'));
    await runGamingArchiveGroundingPreview().catch((error: Error) => {
      expect(error.cause).toBeUndefined();
      expect(error.stack).not.toContain('private-fixture-sentinel');
    });
  });
});
