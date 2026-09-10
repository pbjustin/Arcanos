import { jest } from '@jest/globals';

const core = await import('../src/shared/gaming/gamingSourceAcquisitionCore.js');
const projection = await import('../src/shared/gaming/gamingDocumentProjectionCore.js');
const freshness = await import('../src/shared/gaming/gamingFreshnessCore.js');
const mockSanitize = jest.fn(core.sanitizeGamingSourceUrl);
const mockHttps = jest.fn(core.requireGamingHttpsSourceAdmission);
const mockRedirect = jest.fn(core.resolveGamingDocumentRedirect);
const mockStatus = jest.fn(core.isGamingDocumentRedirectStatus);
const mockProjection = jest.fn(projection.projectGamingDocumentText);
const mockSourcePolicy = jest.fn(freshness.assessGamingSourcePolicy);
const mockFreshness = jest.fn(freshness.extractGamingFreshnessMetadata);
jest.unstable_mockModule('../src/shared/gaming/gamingSourceAcquisitionCore.js', () => ({ ...core,
  sanitizeGamingSourceUrl: mockSanitize, requireGamingHttpsSourceAdmission: mockHttps,
  resolveGamingDocumentRedirect: mockRedirect, isGamingDocumentRedirectStatus: mockStatus }));
jest.unstable_mockModule('../src/shared/gaming/gamingDocumentProjectionCore.js', () => ({ ...projection,
  projectGamingDocumentText: mockProjection }));
jest.unstable_mockModule('../src/shared/gaming/gamingFreshnessCore.js', () => ({ ...freshness,
  assessGamingSourcePolicy: mockSourcePolicy, extractGamingFreshnessMetadata: mockFreshness }));
const { runGamingSourceAcquisitionPreview, GAMING_SOURCE_ACQUISITION_PREVIEW_VERSION } = await import(
  '../src/shared/gaming/gamingSourceAcquisitionPreviewFixture.js');
const FAILURE = 'PREVIEW_GAMING_SOURCE_ACQUISITION_CONTRACT_INVALID';

describe('sealed Gaming source admission and redirect production-core proof', () => {
  beforeEach(() => {
    mockSanitize.mockReset().mockImplementation(core.sanitizeGamingSourceUrl);
    mockHttps.mockReset().mockImplementation(core.requireGamingHttpsSourceAdmission);
    mockRedirect.mockReset().mockImplementation(core.resolveGamingDocumentRedirect);
    mockStatus.mockReset().mockImplementation(core.isGamingDocumentRedirectStatus);
    mockProjection.mockReset().mockImplementation(projection.projectGamingDocumentText);
    mockSourcePolicy.mockReset().mockImplementation(freshness.assessGamingSourcePolicy);
    mockFreshness.mockReset().mockImplementation(freshness.extractGamingFreshnessMetadata);
  });

  it('repeats fixed admission, redirect, finite failure and final-authority assertions without caller input', () => {
    expect(runGamingSourceAcquisitionPreview).not.toThrow();
    expect(runGamingSourceAcquisitionPreview).not.toThrow();
    expect(GAMING_SOURCE_ACQUISITION_PREVIEW_VERSION).toBe('gaming-source-acquisition/v1');
    expect(runGamingSourceAcquisitionPreview).toHaveLength(0);
    expect(mockSanitize).toHaveBeenCalledWith(expect.stringContaining('/Article%2FAlpha?locale=en-GB&q=Variant%20A&part=B&part=A&source=manual'), 2_048);
    expect(mockRedirect).toHaveBeenCalledWith(expect.objectContaining({ redirectCount: 3, location: '/four' }), expect.any(Function));
    expect(mockSourcePolicy).toHaveBeenCalledWith('https://swtor.com/community/synthetic-guide', 'Star Wars: The Old Republic');
  });

  it.each(['www-host', 'case', 'query-order'])('fails closed when admitted identity changes: %s', scenario => {
    mockSanitize.mockImplementation((...args) => {
      const result = core.sanitizeGamingSourceUrl(...args);
      if (!result.url) return result;
      const url = scenario === 'www-host' ? result.url.replace('www.', '')
        : scenario === 'case' ? result.url.toLowerCase() : result.url.replace('part=B&part=A', 'part=A&part=B');
      return { ...result, url };
    });
    expect(runGamingSourceAcquisitionPreview).toThrow(FAILURE);
  });

  it('fails closed when an encoded private path component is admitted', () => {
    mockSanitize.mockImplementation((...args) => args[0].includes('/token%2F')
      ? { rejected: false, url: args[0] } : core.sanitizeGamingSourceUrl(...args));
    expect(runGamingSourceAcquisitionPreview).toThrow(FAILURE);
  });

  it('fails closed when configured source-domain policy disappears', () => {
    mockSanitize.mockImplementation((url, maxChars) => core.sanitizeGamingSourceUrl(url, maxChars));
    expect(runGamingSourceAcquisitionPreview).toThrow(FAILURE);
  });

  it('fails closed when HTTPS downgrade is admitted', () => {
    mockHttps.mockImplementation((admission, ...args) => admission.url?.startsWith('http:')
      ? admission.url : core.requireGamingHttpsSourceAdmission(admission, ...args));
    expect(runGamingSourceAcquisitionPreview).toThrow(FAILURE);
  });

  it.each(['UNAPPROVED_TRANSITION', 'REDIRECT_LOOP', 'REDIRECT_LIMIT', 'INVALID_LOCATION'])(
    'fails closed when a denied redirect is followed: %s', subreason => {
      mockRedirect.mockImplementation((input, admit) => {
        try { return core.resolveGamingDocumentRedirect(input, admit); } catch (error) {
          if (!(error instanceof core.GamingDocumentAcquisitionError) || error.acquisition.subreason !== subreason) throw error;
          return { fromUrl: input.currentUrl, toUrl: 'https://www.guides.example/unexpected',
            classification: 'same_origin', ruleId: 'gaming.redirect.same_origin' };
        }
      });
      expect(runGamingSourceAcquisitionPreview).toThrow(FAILURE);
    }
  );

  it('fails closed when a reviewed publisher redirect loses its exact rule', () => {
    mockRedirect.mockImplementation((...args) => {
      const result = core.resolveGamingDocumentRedirect(...args);
      return result.classification === 'reviewed_publisher_pair' ? { ...result, ruleId: 'gaming.redirect.unreviewed' } : result;
    });
    expect(runGamingSourceAcquisitionPreview).toThrow(FAILURE);
  });

  it.each([304, 308])('fails closed when redirect status handling changes: %s', status => {
    mockStatus.mockImplementation(value => value === status ? !core.isGamingDocumentRedirectStatus(value)
      : core.isGamingDocumentRedirectStatus(value));
    expect(runGamingSourceAcquisitionPreview).toThrow(FAILURE);
  });

  it('fails closed when acquired source instructions survive prose projection', () => {
    mockProjection.mockImplementation(input => ({ text: input.acquiredText, cleanedTextLength: input.acquiredText.length,
      truncated: false, instructionFiltered: false }));
    expect(runGamingSourceAcquisitionPreview).toThrow(FAILURE);
  });

  it('fails closed when the final URL inherits the initial URL authority', () => {
    mockSourcePolicy.mockImplementation((...args) => ({ ...freshness.assessGamingSourcePolicy(...args), authority: 'official' }));
    expect(runGamingSourceAcquisitionPreview).toThrow(FAILURE);
  });

  it('fails closed when a display URL promotes an acquired article to a current index', () => {
    mockFreshness.mockImplementation((document, ...args) => freshness.extractGamingFreshnessMetadata({ ...document,
      canonicalUrl: undefined }, ...args));
    expect(runGamingSourceAcquisitionPreview).toThrow(FAILURE);
  });

  it('withholds unexpected core exception details and returns only the fixed failure', () => {
    mockSanitize.mockImplementation(() => { throw new Error('private-source-preview-sentinel'); });
    let failure: unknown;
    try { runGamingSourceAcquisitionPreview(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(FAILURE);
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain('private-source-preview-sentinel');
  });
});
