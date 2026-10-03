import { describe, expect, it, jest } from '@jest/globals';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import type { GamingEvidenceUnit } from '../src/shared/gaming/gamingEvidenceUnits.js';
import type { GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';

const mockHttp = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(mockHttp) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
const { selectGamingHybridEvidence, evaluateGamingHybridCandidates, selectGamingHybridAcceptedEvidence,
  assertGamingHybridEvidenceMembership } = await import('../src/services/gamingHybridCandidates.js');
const { assessGamingClearEvidence, assessGamingRequestCoverage } = await import('../src/shared/gaming/gamingClearEvidence.js');
const { isGamingMcpOutput } = await import('../src/shared/chatgpt/gamingMcpContract.js');
const { buildGamingRequestRequirements } = await import('../src/shared/gaming/gamingRetrievalPolicy.js');
const { extractGamingFreshnessMetadata } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const { GamingDocumentAcquisitionError } = await import('../src/services/gamingDocumentResolution.js');
const { selectGamingCoverageEvidence } = await import('../src/shared/gaming/gamingStoredEvidenceCore.js');
const { gamingCrossSourceStructuralConflict, readGamingEvidenceUnits } = await import('../src/shared/gaming/gamingStructuralEvidence.js');
const fetchedAt = new Date().toISOString();

function knowledge(texts: string[], game = 'Lantern Voyage'): GamingStoredKnowledgeContext {
  const sources = texts.map((text, index) => ({ sourceId: `candidate-${index}`, game,
    url: `https://guides.example.org/guide-${index}`, sourceType: 'supplied', origin: 'live' as const,
    fetchedAt, snippet: text }));
  return { context: '', sources, evidence: texts.map((text, index) => ({ sourceId: sources[index].sourceId,
    revisionId: `revision-${index}`, recordId: `record-${index}`, recordType: 'guide', publicUrl: sources[index].url,
    text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt } })) };
}

const input = { game: 'Lantern Voyage', mode: 'guide' as const,
  prompt: 'How do I activate amber gate and cross crystal bridge?' };

describe('v2 existing backend evidence selection and request coverage', () => {
  it('chooses the smallest complete passage for a single topic without explicit clauses', () => {
    const request = { ...input, prompt: 'How do I activate amber gate?' };
    expect(buildGamingRequestRequirements(request)).toEqual([]);
    const data = knowledge(['Activate amber gate using the copper switch beside the lantern.',
      'Activate amber gate using the copper switch beside the lantern. This redundant guide repeats the complete activation instructions.']);
    const selected = selectGamingHybridEvidence(request, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.selectedCandidateIds).toEqual(['candidate-0']);
  });

  it('fails closed when the pure v2 selector has no authoritative coverage assessor', () => {
    const data = knowledge(['Activate amber gate using the copper switch. Cross crystal bridge by following the blue lanterns.']);
    const candidates = [{ source: data.sources[0], evidence: data.evidence![0] }];
    const limits = { chunkChars: 1600, maxChunks: 8, maxSources: 3, maxContextChars: 5000, structuredEvidenceChars: 8000 };
    expect(selectGamingCoverageEvidence(candidates, { ...input, requireRequestCoverage: true }, limits)).toEqual([]);
    expect(selectGamingCoverageEvidence(candidates, { ...input, requireRequestCoverage: true }, limits, assessGamingRequestCoverage)).toHaveLength(1);
  });

  it('prunes a twenty-passage prose pool that cannot cover a single requested topic', () => {
    const request = { ...input, prompt: 'Explain Copperstaff Zephyrglass Sunspire Moonvault' };
    expect(buildGamingRequestRequirements(request)).toEqual([]);
    const data = knowledge(Array.from({ length: 20 }, (_unused, index) =>
      `Copperstaff rests beside the quiet eastern lantern. This intact passage explains the unrelated cabinet route ${index}.`));
    const candidates = data.evidence!.map((evidence, index) => ({ evidence, source: data.sources[index] }));
    const assess = jest.fn(assessGamingRequestCoverage);
    const selected = selectGamingCoverageEvidence(candidates, { ...request, requireRequestCoverage: true },
      { chunkChars: 1600, maxChunks: 8, maxSources: 3, maxContextChars: 5000, structuredEvidenceChars: 8000 }, assess);
    expect(assessGamingRequestCoverage(request, { context: '', sources: selected.map(candidate => candidate.source),
      evidence: selected.map(candidate => candidate.evidence) }).coverageSatisfied).toBe(false);
    expect(assess.mock.calls.length).toBeLessThan(100);
  });

  it.each([
    { name: 'table-only negative', complete: false, prose: false, requiredProof: false, location: false },
    { name: 'valid table positive', complete: true, prose: false, requiredProof: false, location: false },
    { name: 'mixed partial negative', complete: false, prose: true, requiredProof: false, location: false },
    { name: 'independent prose positive', complete: true, prose: true, requiredProof: false, location: false },
    { name: 'mandatory excluded proof with prose', complete: true, prose: true, requiredProof: true, location: false },
    { name: 'mixed tuple shapes negative', complete: false, prose: false, requiredProof: false, location: true },
    { name: 'mixed tuple shapes positive', complete: true, prose: false, requiredProof: false, location: true }
  ])('bounds wrong-statistic search and preserves coverage: $name', ({ complete, prose, requiredProof, location }) => {
    const request = { ...input, prompt: location ? 'Find Copperblade weight value' : 'What is Copperblade weight value?' };
    const data = knowledge(Array.from({ length: 20 }, () => 'Placeholder table row.'));
    for (const [index, chunk] of data.evidence!.entries()) {
      const fields = location && index === 18 ? [{ label: 'System', value: 'Alpha' }, { label: 'Body', value: 'Beta' },
        { label: 'Site', value: 'T-1' }, { label: 'Resource', value: 'Copperblade' }] :
        [{ label: 'Item', value: 'Copperblade' }, { label: 'Stat', value: complete && index === 19 ? 'weight' : 'damage' },
        { label: 'Value', value: '10' }, { label: 'Unit', value: 'points' }, { label: 'Scope', value: 'base' }];
      const unit: GamingEvidenceUnit = { id: `bounded-row-${index}`, kind: 'table_row',
        text: fields.map(field => `${field.label}: ${field.value}`).join(' | '), fields,
        context: { scope: 'stats' }, integrity: { status: 'complete', reasons: [] },
        provenance: { sourceUrl: chunk.publicUrl, strategy: 'html_table', representation: 'html_dom',
          policyVersion: 'gaming-evidence-units/v1', locator: 'table[0]/tr[0]' } };
      chunk.text = unit.text; chunk.evidenceUnits = [unit];
    }
    if (prose) {
      data.evidence![19].evidenceUnits = [];
      data.evidence![19].text = complete ? 'Copperblade weight value is 10 points for the base equipment described in this guide.'
        : 'Copperblade rests beside the quiet eastern lantern. This intact guide explains the unrelated cabinet route.';
    }
    if (requiredProof) data.evidence![0].recordId += ':verification';
    const assess = jest.fn((...args: Parameters<typeof assessGamingRequestCoverage>) => {
      if (assess.mock.calls.length > 1000) throw new Error('Synthetic selector assessment ceiling exceeded');
      return assessGamingRequestCoverage(...args);
    });
    const selected = selectGamingCoverageEvidence(data.evidence!.map((evidence, index) => ({ evidence, source: data.sources[index] })),
      { ...request, requireRequestCoverage: true, requiredSourceIds: requiredProof ? ['candidate-0'] : [] },
      { chunkChars: 1600, maxChunks: 8, maxSources: 3, maxContextChars: 5000, structuredEvidenceChars: 8000 }, assess);
    expect(assessGamingRequestCoverage(request, { context: '', sources: selected.map(candidate => candidate.source),
      evidence: selected.map(candidate => candidate.evidence) }).coverageSatisfied).toBe(complete);
    expect(assess.mock.calls.length).toBeLessThan(1000);
    if (complete) expect(selected.map(candidate => candidate.evidence.recordId).sort())
      .toEqual(requiredProof ? ['record-0:verification', 'record-19'] : ['record-19']);
  });

  it('selects one complete source and removes redundant alternatives without requiring publishers', () => {
    const data = knowledge(['Activate amber gate using the copper switch. Cross crystal bridge by following the blue lanterns.',
      'Activate amber gate using the copper switch. Cross crystal bridge by following the blue lanterns. The guide repeats these complete instructions.']);
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.knowledge.sources).toHaveLength(1);
    expect(selected.selectedCandidateIds).toHaveLength(1);
    expect(selected.requirementSupport).toHaveLength(2);
    expect(selected.requirementSupport.every(item => item.candidateIds.length === 1 && item.evidenceIds.length === 1)).toBe(true);
  });

  it.each([
    { game: 'Lantern Voyage', prompt: input.prompt,
      texts: ['Activate amber gate using the copper switch beside the lantern.', 'Cross crystal bridge by following the blue lanterns past the entrance.'] },
    { game: 'Stardew Valley', prompt: 'How do I repair greenhouse and unlock minecart?',
      texts: ['Repair greenhouse after completing the community bundle described in this guide.', 'Unlock minecart after finishing the boiler room bundle described in this guide.'] }
  ])('combines complementary request requirements through the same policy for $game', ({ game, prompt, texts }) => {
    const request = { game, prompt, mode: 'guide' as const };
    for (const text of texts) expect(assessGamingRequestCoverage(request, knowledge([text], game)).coverageSatisfied).toBe(false);
    const selected = selectGamingHybridEvidence(request, knowledge(texts, game));
    expect(selected).toMatchObject({ coverageSatisfied: true, gapAssessmentStatus: 'assessed', missingCoverage: [] });
    expect(selected.knowledge.sources).toHaveLength(2);
    expect(selected.requirementSupport.map(item => item.candidateIds)).toEqual([['candidate-0'], ['candidate-1']]);
    expect(selected.requirementSupport.map(item => item.evidenceIds)).toEqual([['record-0'], ['record-1']]);
  });

  it('reports only the actually unsupported requested clause and retains useful evidence', () => {
    const selected = selectGamingHybridEvidence(input, knowledge(['Activate amber gate using the copper switch beside the lantern.']));
    expect(selected).toMatchObject({ coverageSatisfied: false, gapAssessmentStatus: 'assessed', missingCoverage: ['requested topic 2'] });
    expect(selected.knowledge.sources).toHaveLength(1);
    expect(selected.requirementSupport[0].evidenceIds).toEqual(['record-0']);
    expect(selected.requirementSupport[1].evidenceIds).toEqual([]);
  });

  it('marks unknown gaps honestly instead of inventing a build facet', () => {
    const selected = selectGamingHybridEvidence({ ...input, prompt: 'Explain copper staff tactics.' }, knowledge(['Weather descriptions cover the coastal harbor.']));
    expect(selected).toMatchObject({ coverageSatisfied: false, gapAssessmentStatus: 'unknown', missingCoverage: [] });
    expect(JSON.stringify(selected.requirementSupport)).not.toContain('stat allocation');
  });

  it('keeps an explicit short facet and never exposes private request or player strings', () => {
    const request = { ...input, prompt: 'Explain weapon configuration and stats.', currentArea: 'Private guild Moonstone' };
    expect(buildGamingRequestRequirements(request)).toHaveLength(2);
    const selected = selectGamingHybridEvidence(request, knowledge(['Weapon configuration uses the copper staff beside the lantern.']));
    expect(selected.missingCoverage).toEqual(['requested topic 2']);
    const privateRequest = { ...input, prompt: 'Explain weapon configuration and guild Moonstone Private Server strategy.' };
    const diagnostic = assessGamingRequestCoverage(privateRequest, knowledge([]));
    expect(JSON.stringify(diagnostic)).not.toMatch(/Moonstone|Private Server|guild/u);
  });

  it('clarifies an over-broad explicit request instead of silently dropping its ninth facet', () => {
    const clauses = Array.from({ length: 9 }, (_unused, index) => `activate beacon${index}`);
    const data = knowledge([clauses.slice(0, 8).join('. ')]);
    const selected = selectGamingHybridEvidence({ ...input, prompt: clauses.join(' and ') }, data);
    expect(selected).toMatchObject({ coverageSatisfied: false, gapAssessmentStatus: 'not_assessed',
      missingCoverage: [], clarification: 'Which requested topics should the bounded guide cover first?' });
  });

  it('keeps repeated canonical facets distinct and output-schema compatible', () => {
    const selected = selectGamingHybridEvidence({ ...input, prompt: 'weapon configuration for strength and weapon configuration for dexterity' }, knowledge([]));
    expect(selected.missingCoverage).toEqual(['weapon configuration (requested topic 1)', 'weapon configuration (requested topic 2)']);
    expect(isGamingMcpOutput('arcanos_gaming_hybrid_query', { statusCode: 200, result: {
      contractVersion: 'gaming-hybrid-v2', requestId: 'repeated-facet-fixture', revision: 0,
      state: 'discovery_required', nextAction: 'stop', reason: 'FIXTURE_SELECTION', sourceKnown: false,
      evidenceSelected: false, freshnessStatus: 'unverified', selectedCandidateIds: [], selectedEvidenceIds: [],
      coverageSatisfied: selected.coverageSatisfied, missingCoverage: selected.missingCoverage,
      gapAssessmentStatus: selected.gapAssessmentStatus, requirementSupport: selected.requirementSupport
    } })).toBe(true);
  });

  it('clarifies a broad build without inventing progress or an archetype', () => {
    expect(assessGamingRequestCoverage({ ...input, mode: 'build', prompt: 'Recommend the best build.' }, knowledge([])))
      .toMatchObject({ coverageSatisfied: false, gapAssessmentStatus: 'not_assessed', clarification: expect.any(String) });
  });

  it('does not let compaction hide a material metadata conflict in a complete redundant source', () => {
    const data = knowledge(['Activate amber gate using the copper switch. Cross crystal bridge following the blue lanterns.',
      'Activate amber gate using the copper switch. Cross crystal bridge following the blue lanterns. Additional complete instructions.']);
    for (const [index, source] of data.sources.entries()) source.freshnessMetadata = { id: source.sourceId, game: input.game,
      url: source.url, fetchedAt, mechanicValues: { amber_gate_switch: index ? 'west' : 'east' } };
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.materialConflict).toBe(true);
    expect(selected.knowledge.sources).toHaveLength(0);
    expect(selected.selectedEvidenceIds).toEqual([]);
    expect(assessGamingClearEvidence(input, data, { requireRequestCoverage: true }).blockingFindings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONTRADICTORY_EVIDENCE' })]));
  });

  it('treats original required-source instructions separately from gameplay coverage requirements', () => {
    const request = { ...input, prompt: 'Using this required guide (https://required.example.org/guide), how do I activate amber gate and cross crystal bridge? Use only https://required.example.org/guide.' };
    const requirements = buildGamingRequestRequirements(request);
    expect(requirements.map(item => item.terms)).toEqual([['activate', 'amber', 'gate'], ['cross', 'crystal', 'bridge']]);
  });

  it('preserves a required complete guide when another complete source is redundant', () => {
    const data = knowledge(['Activate amber gate using the copper switch. Cross crystal bridge following the blue lanterns.',
      'Activate amber gate using the copper switch. Cross crystal bridge following the blue lanterns. Additional complete guidance.']);
    const selected = selectGamingHybridEvidence(input, data, { requiredSourceIds: ['candidate-1'] });
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.selectedCandidateIds).toEqual(['candidate-1']);
  });

  it('preserves required backend currentness proof without making it gameplay evidence', () => {
    const data = knowledge(['Activate amber gate using the copper switch. Cross crystal bridge following the blue lanterns.',
      'Backend-verified official release index; Applicable patch: 2.1.']);
    data.sources[1].sourceType = 'official_updates';
    data.sources[1].freshnessMetadata = { id: data.sources[1].sourceId, game: input.game, url: data.sources[1].url,
      currentness: 'current_index', category: 'official_updates', fetchedAt };
    data.evidence![1].recordId = 'candidate-1:verification';
    const selected = selectGamingHybridEvidence(input, data, { requiredSourceIds: ['candidate-1'] });
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.knowledge.sources).toHaveLength(2);
    expect(selected.selectedEvidenceIds).toContain('candidate-1:verification');
    expect(selected.requirementSupport.every(item => item.evidenceIds.every(id => id !== 'candidate-1:verification'))).toBe(true);
  });

  it('reserves currentness proof by bounded evidence cost when a fourth source is necessary', () => {
    const request = { ...input, prompt: 'activate amber gate and cross crystal bridge and repair silver lever' };
    const data = knowledge(['Activate amber gate using the copper switch beside the lantern.',
      'Cross crystal bridge following the blue lanterns past the entrance.',
      'Repair silver lever using the tool described beside the eastern pedestal.',
      'Backend-verified official release index; Applicable patch: 2.1.']);
    data.sources[3].sourceType = 'official_updates';
    data.sources[3].freshnessMetadata = { id: data.sources[3].sourceId, game: input.game, url: data.sources[3].url,
      currentness: 'current_index', category: 'official_updates', fetchedAt };
    data.evidence![3].recordId = 'candidate-3:verification';
    const selected = selectGamingHybridEvidence(request, data, { requiredSourceIds: ['candidate-3'] });
    expect(selected.knowledge.sources).toHaveLength(4);
    expect(selected.selectedEvidenceIds).toContain('candidate-3:verification');
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.missingCoverage).toHaveLength(0);
  });

  describe('discovery identities versus bounded generation evidence cost', () => {
    const clauses = ['activate amber gate', 'cross crystal bridge', 'repair silver lever', 'unlock copper vault'];
    const passages = clauses.map(clause => `${clause} using the instructions beside the eastern lantern. Follow these intact guide steps carefully.`);
    const request = { ...input, prompt: clauses.join(' and ') };

    it.each([
      { name: 'one source', texts: [passages.join(' ')], sources: 1 },
      { name: 'two complementary sources', texts: [passages.slice(0, 2).join(' '), passages.slice(2).join(' ')], sources: 2 },
      { name: 'three sources', texts: [passages.slice(0, 2).join(' '), passages[2], passages[3]], sources: 3 },
      { name: 'four tiny sources', texts: passages, sources: 4 }
    ])('covers all independent clauses using $name inside unchanged context limits', ({ texts, sources }) => {
      const result = selectGamingHybridEvidence(request, knowledge(texts));
      expect(result.coverageSatisfied).toBe(true);
      expect(result.knowledge.sources).toHaveLength(sources);
      expect(result.knowledge.evidence!.length).toBeLessThanOrEqual(8);
      expect(result.knowledge.context.length).toBeLessThanOrEqual(5_000);
      expect(result.requirementSupport).toHaveLength(4);
      expect(result.requirementSupport.every(item => item.evidenceIds.length > 0)).toBe(true);
      const selectedUrls = result.knowledge.sources.map(source => source.url);
      expect(result.knowledge.evidence!.every(chunk => selectedUrls.includes(chunk.publicUrl))).toBe(true);
    });

    it('stops honestly when four intact complementary passages exceed the available context', () => {
      const data = knowledge(passages.map(passage => passage.padEnd(600, ' harmless background')));
      const result = selectGamingHybridEvidence({ ...request, maxContextChars: 1_200 }, data);
      expect(result.coverageSatisfied).toBe(false);
      expect(result.missingCoverage.length).toBeGreaterThan(0);
      expect(result.knowledge.context.length).toBeLessThanOrEqual(1_200);
      expect(result.knowledge.evidence!.length).toBeLessThanOrEqual(8);
      expect(result.knowledge.evidence!.every(chunk => data.evidence!.some(original => original.text === chunk.text))).toBe(true);
    });

    it('selects the two-source minimum cover from six accepted identities and exposes only selected citations', () => {
      const data = knowledge([passages.slice(0, 2).join(' '), passages.slice(2).join(' '), ...passages]);
      const result = selectGamingHybridEvidence(request, data);
      expect(result.coverageSatisfied).toBe(true);
      expect(result.selectedCandidateIds.sort()).toEqual(['candidate-0', 'candidate-1']);
      expect(result.selectedEvidenceIds.sort()).toEqual(['record-0', 'record-1']);
      expect(result.knowledge.sources.map(source => source.url).sort()).toEqual(data.sources.slice(0, 2).map(source => source.url).sort());
      expect(result.requirementSupport.every(item => item.candidateIds.every(id => result.selectedCandidateIds.includes(id)))).toBe(true);
    });

    it('still vetoes an unselected conflicting identity in the complete acquired pool', () => {
      const data = knowledge([passages.slice(0, 2).join(' '), passages.slice(2).join(' '), ...passages]);
      for (const [index, source] of data.sources.entries()) source.freshnessMetadata = { id: source.sourceId,
        game: input.game, url: source.url, fetchedAt, mechanicValues: { amber_gate_switch: index === 5 ? 'west' : 'east' } };
      expect(selectGamingHybridEvidence(request, data)).toMatchObject({ materialConflict: true, coverageSatisfied: false,
        selectedCandidateIds: [], selectedEvidenceIds: [], knowledge: { sources: [] } });
    });

    it('uses two compact passages instead of one costly complete source that would not fit the reserved context', () => {
      const data = knowledge([passages.join(' ').padEnd(1_200, ' harmless background'),
        passages.slice(0, 2).join(' '), passages.slice(2).join(' ')]);
      const result = selectGamingHybridEvidence({ ...request, maxContextChars: 1_100 }, data);
      expect(result.coverageSatisfied).toBe(true);
      expect(result.selectedCandidateIds.sort()).toEqual(['candidate-1', 'candidate-2']);
      expect(result.knowledge.context.length).toBeLessThanOrEqual(1_100);
    });
  });

  it('bounds public evidence IDs for rich tables and records only actually supporting unit relationships', () => {
    const data = knowledge(['']);
    data.sources[0].origin = 'stored';
    const units: GamingEvidenceUnit[] = Array.from({ length: 35 }, (_unused, index) => ({
      id: `weapon-unit-${index}`, kind: 'table_row', text: `Weapon wand${index};Skill a;`,
      fields: [{ label: 'Weapon', value: `wand${index}` }, { label: 'Skill', value: 'a' }],
      context: { scope: 'weapons' }, integrity: { status: 'complete', reasons: [] },
      provenance: { sourceUrl: data.sources[0].url, strategy: 'html_table', representation: 'html_dom',
        policyVersion: 'gaming-evidence-units/v1', locator: `table[0]/tr[${index}]` }
    }));
    data.evidence![0].evidenceUnits = units;
    data.evidence![0].text = units.map(unit => unit.text).join('\n\n');
    const selected = selectGamingHybridEvidence({ ...input, prompt: 'weapon wand0 and weapon wand1' }, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.knowledge.evidence![0].evidenceUnits).toHaveLength(35);
    expect(selected.selectedEvidenceIds).toEqual(['record-0']);
    expect(selected.requirementSupport.map(item => item.evidenceIds)).toEqual([['record-0'], ['record-0']]);
    expect(selected.requirementUnitSupport).toEqual([
      { requirement: 'requested topic 1', evidenceUnitIds: ['weapon-unit-0'] },
      { requirement: 'requested topic 2', evidenceUnitIds: ['weapon-unit-1'] }
    ]);
    expect(isGamingMcpOutput('arcanos_gaming_hybrid_query', { statusCode: 200, result: {
      contractVersion: 'gaming-hybrid-v2', requestId: 'rich-guide-fixture', revision: 0,
      state: 'discovery_required', nextAction: 'stop', reason: 'FIXTURE_SELECTION', sourceKnown: true,
      evidenceSelected: true, freshnessStatus: 'current', selectedCandidateIds: selected.selectedCandidateIds,
      selectedEvidenceIds: selected.selectedEvidenceIds, coverageSatisfied: selected.coverageSatisfied,
      missingCoverage: selected.missingCoverage, gapAssessmentStatus: selected.gapAssessmentStatus,
      requirementSupport: selected.requirementSupport
    } })).toBe(true);
  });

  it('detects cross-publisher structured disagreement without changing the v1 local tuple policy', () => {
    const data = knowledge(['', '']);
    for (const [index, chunk] of data.evidence!.entries()) {
      const fields = [{ label: 'Item', value: 'Copperblade' }, { label: 'Stat', value: 'damage' },
        { label: 'Value', value: String(10 + index) }, { label: 'Unit', value: 'points' }, { label: 'Scope', value: 'base' }];
      const unit: GamingEvidenceUnit = { id: `stat-unit-${index}`, kind: 'table_row',
        text: fields.map(field => `${field.label}: ${field.value}`).join(' | '), fields,
        context: { scope: 'stats' }, integrity: { status: 'complete', reasons: [] },
        provenance: { sourceUrl: chunk.publicUrl, strategy: 'html_table', representation: 'html_dom',
          policyVersion: 'gaming-evidence-units/v1', locator: 'table[0]/tr[0]' } };
      chunk.evidenceUnits = [unit]; chunk.text = unit.text;
    }
    const request = { ...input, prompt: 'What is Copperblade damage value?' };
    expect(assessGamingClearEvidence(request, data).blockingFindings.map(finding => finding.code)).not.toContain('CONTRADICTORY_EVIDENCE');
    expect(selectGamingHybridEvidence(request, data)).toMatchObject({ materialConflict: true, coverageSatisfied: false, selectedEvidenceIds: [] });
  });

  it('supports independent requested structural facts without requiring one row to contain both entities', () => {
    const data = knowledge(['', '']);
    for (const [index, chunk] of data.evidence!.entries()) {
      const fields = [{ label: 'Item', value: index ? 'Silverblade' : 'Copperblade' }, { label: 'Stat', value: 'weight' },
        { label: 'Value', value: String(10 + index) }, { label: 'Unit', value: 'points' }, { label: 'Scope', value: 'base' }];
      const unit: GamingEvidenceUnit = { id: `weight-unit-${index}`, kind: 'table_row',
        text: fields.map(field => `${field.label}: ${field.value}`).join(' | '), fields,
        context: { scope: 'stats' }, integrity: { status: 'complete', reasons: [] },
        provenance: { sourceUrl: chunk.publicUrl, strategy: 'html_table', representation: 'html_dom',
          policyVersion: 'gaming-evidence-units/v1', locator: 'table[0]/tr[0]' } };
      chunk.evidenceUnits = [unit]; chunk.text = unit.text;
    }
    const request = { ...input, prompt: 'What is Copperblade weight value and Silverblade weight value?' };
    const coverage = assessGamingRequestCoverage(request, data);
    expect(coverage.requirementSupport.map(item => item.evidenceIds)).toEqual([['record-0'], ['record-1']]);
    expect(coverage).toMatchObject({ coverageSatisfied: true, missingCoverage: [] });
    const selected = selectGamingHybridEvidence(request, data);
    expect(selected).toMatchObject({ coverageSatisfied: true, materialConflict: false, selectedEvidenceIds: ['record-0', 'record-1'] });
    const v2 = assessGamingClearEvidence(request, selected.knowledge, { requireRequestCoverage: true });
    expect(v2.gates.claimSupport).toBe('verified');
    expect(v2.blockingFindings).toEqual([]);
    expect(assessGamingClearEvidence(request, data).gates.claimSupport).toBe('unknown');
    expect(assessGamingRequestCoverage(request, { ...data, evidence: data.evidence!.slice(0, 1) }))
      .toMatchObject({ coverageSatisfied: false, missingCoverage: ['requested topic 2'] });
    for (const missingField of ['Value', 'Unit', 'Scope']) {
      const incomplete = structuredClone(data);
      const chunk = incomplete.evidence![1];
      const unit = chunk.evidenceUnits![0];
      unit.fields = unit.fields.filter(field => field.label !== missingField);
      unit.text = unit.fields.map(field => `${field.label}: ${field.value}`).join(' | ');
      chunk.text = unit.text;
      expect(assessGamingRequestCoverage(request, incomplete))
        .toMatchObject({ coverageSatisfied: false, missingCoverage: ['requested topic 2'] });
      expect(assessGamingClearEvidence(request, incomplete, { requireRequestCoverage: true }).gates.claimSupport).toBe('unknown');
    }
    const invalid = structuredClone(data);
    invalid.evidence![1].evidenceUnits![0].integrity.status = 'partial';
    expect(selectGamingHybridEvidence(request, invalid).coverageSatisfied).toBe(false);
  });

  it('stored source identities cannot impersonate accepted workflow candidate handles', () => {
    const data = knowledge(['Activate amber gate using the copper switch. Cross crystal bridge following the blue lanterns.']);
    data.sources[0].origin = 'stored';
    const selected = selectGamingHybridEvidence(input, data);
    expect(selected.coverageSatisfied).toBe(true);
    expect(selected.selectedCandidateIds).toEqual([]);
    expect(selected.selectedEvidenceIds).toEqual(['record-0']);
    expect(selected.requirementSupport.every(item => item.candidateIds.length === 0)).toBe(true);
  });

  it('keeps unavailable full-pool inspection distinct from a verified contradiction through compaction', () => {
    const text = 'Activate amber gate using the copper switch. Cross crystal bridge following the blue lanterns.';
    const permitted = knowledge(Array.from({ length: 17 }, () => text));
    expect(selectGamingHybridEvidence(input, permitted)).toMatchObject({ materialConflict: false, coverageSatisfied: true });
    const unavailable = knowledge(Array.from({ length: 18 }, () => text));
    const selected = selectGamingHybridEvidence(input, unavailable);
    expect(selected).toMatchObject({ materialConflict: false, inspectionUnavailable: true, coverageSatisfied: false,
      gapAssessmentStatus: 'unknown', selectedCandidateIds: [], selectedEvidenceIds: [] });
    expect(assessGamingClearEvidence(input, unavailable, { requireRequestCoverage: true }).blockingFindings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'STRUCTURAL_CONFLICT_ASSESSMENT_UNVERIFIED' })]));
    const compact = { ...knowledge([text]), structuralConflictAssessmentUnavailable: true };
    expect(selectGamingHybridEvidence(input, compact)).toMatchObject({ materialConflict: false, inspectionUnavailable: true, selectedEvidenceIds: [] });
    expect(assessGamingClearEvidence(input, compact, { requireRequestCoverage: true }).gates.claimSupport).toBe('unknown');
  });

  it('validates whole source batches without enlarging the document cap or accepting split oversized sources', () => {
    const sourceUrl = 'https://guides.example.org/weights';
    const unit: GamingEvidenceUnit = { id: 'weight-unit', kind: 'table_row',
      text: 'Item: Copperblade | Stat: weight | Value: 10 | Unit: points | Scope: base',
      fields: [{ label: 'Item', value: 'Copperblade' }, { label: 'Stat', value: 'weight' },
        { label: 'Value', value: '10' }, { label: 'Unit', value: 'points' }, { label: 'Scope', value: 'base' }],
      context: { scope: 'stats' }, integrity: { status: 'complete', reasons: [] },
      provenance: { sourceUrl, strategy: 'html_table', representation: 'html_dom', policyVersion: 'gaming-evidence-units/v1', locator: 'table[0]/tr[0]' } };
    const request = { prompt: 'What is Copperblade weight value?' };
    const units = Array.from({ length: 2_049 }, (_unused, index) => ({ ...unit, id: `weight-unit-${index}` }));
    expect(readGamingEvidenceUnits(units)).toEqual([]);
    expect(gamingCrossSourceStructuralConflict({ ...request, sources: [{ sourceUrl, units }] })).toBeUndefined();
    expect(gamingCrossSourceStructuralConflict({ ...request, sources: [{ sourceUrl, units: units.slice(0, 2_048) },
      { sourceUrl, units: units.slice(2_048) }] })).toBeUndefined();
    expect(gamingCrossSourceStructuralConflict({ ...request, sources: [{ sourceUrl, units: [unit] }, { sourceUrl, units: [unit] }] })).toBe(false);
    expect(gamingCrossSourceStructuralConflict({ ...request, sources: [{ sourceUrl, units: [{ ...unit, text: 'Malformed unrelated text.' }] }] })).toBeUndefined();
  });
});

describe('v2 independently acquired bound artifacts and failure work accounting', () => {
  const actor = { actorKey: 'fixture-actor', workflowId: 'fixture-workflow' };
  const url = 'https://guides.example.org/lantern-gate';
  function readableDocument() {
    mockHttp.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>Lantern Voyage guide</title><body><article>Lantern Voyage guide. Activate amber gate using the copper switch beside the lantern.
        This guide explains safe amber gate activation in Lantern Voyage and gives intact steps for using the switch.
        Further bridge mechanics are described in a separate guide.</article></body></html>` }));
  }
  it('retains a valid incomplete acquired document and enforces actor/workflow/content membership', async () => {
    readableDocument();
    const evaluated = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] }, actor);
    expect(evaluated.accepted).toHaveLength(1);
    const retained = selectGamingHybridAcceptedEvidence(input, evaluated.accepted, actor);
    expect(assessGamingRequestCoverage(input, retained).coverageSatisfied).toBe(false);
    expect(() => assertGamingHybridEvidenceMembership(retained, evaluated.accepted, actor)).not.toThrow();
    expect(() => selectGamingHybridAcceptedEvidence({ ...input, prompt: 'A different question' }, evaluated.accepted, actor)).toThrow();
    expect(() => assertGamingHybridEvidenceMembership(retained, evaluated.accepted, { ...actor, actorKey: 'other-actor' })).toThrow();
    expect(() => assertGamingHybridEvidenceMembership(retained, evaluated.accepted, { ...actor, workflowId: 'other-workflow' })).toThrow();
    const fabricated = { ...retained, evidence: retained.evidence!.map(chunk => ({ ...chunk, recordId: 'fabricated-record' })) };
    expect(() => assertGamingHybridEvidenceMembership(fabricated, evaluated.accepted, actor)).toThrow();
  });

  it('assesses all six acquired artifacts for conflict before the existing source/chunk selection bound', async () => {
    mockHttp.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>Lantern Voyage guide</title><body><article>Lantern Voyage guide. Activate amber gate using the copper switch beside the lantern.
        Cross crystal bridge following the blue lanterns. This guide explains intact amber gate activation and crystal bridge crossing in Lantern Voyage.</article></body></html>` }));
    const extractFreshness: typeof extractGamingFreshnessMetadata = (document, request, now) => ({
      ...extractGamingFreshnessMetadata(document, request, now),
      mechanicValues: { amber_gate_switch: document.publicUrl.endsWith('/contradiction') ? 'west' : 'east' }
    });
    const urls = Array.from({ length: 6 }, (_unused, index) => `https://guides.example.org/${index === 5 ? 'contradiction' : `guide-${index}`}`);
    const first = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2', candidates: urls.slice(0, 3).map(url => ({ url })) }, actor, { extractFreshness });
    const second = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2', candidates: urls.slice(3).map(url => ({ url })) }, actor, { extractFreshness });
    const accepted = [...first.accepted, ...second.accepted];
    expect(accepted).toHaveLength(6);
    const retained = selectGamingHybridAcceptedEvidence(input, accepted, actor);
    expect(retained.sources.length).toBeLessThanOrEqual(3);
    expect(retained.materialConflict).toBe(true);
    expect(selectGamingHybridEvidence(input, retained)).toMatchObject({ materialConflict: true, selectedEvidenceIds: [], coverageSatisfied: false });
  });

  it('retains a structural conflict veto when six acquired tables exceed the per-document unit limit in aggregate', async () => {
    mockHttp.mockImplementation(async (requestUrl: string) => ({ status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>Lantern Voyage guide</title><body><article>Lantern Voyage weapon weights.
        <table><thead><tr><th>Item</th><th>Stat</th><th>Value</th><th>Unit</th><th>Scope</th><th>Note</th></tr></thead><tbody>
        ${Array.from({ length: 350 }, (_unused, index) => `<tr><td>Copperblade</td><td>weight</td><td>${requestUrl.endsWith('/contradiction') ? 11 : 10}</td><td>points</td><td>base</td><td>entry ${index}</td></tr>`).join('')}
        </tbody></table></article></body></html>` }));
    const request = { ...input, prompt: 'What is Copperblade weight value?' };
    const urls = Array.from({ length: 6 }, (_unused, index) => `https://guides.example.org/${index === 5 ? 'contradiction' : `weight-${index}`}`);
    const first = await evaluateGamingHybridCandidates({ ...request, protocolVersion: 'gaming-hybrid-v2', candidates: urls.slice(0, 3).map(url => ({ url })) }, actor);
    const second = await evaluateGamingHybridCandidates({ ...request, protocolVersion: 'gaming-hybrid-v2', candidates: urls.slice(3).map(url => ({ url })) }, actor);
    const accepted = [...first.accepted, ...second.accepted];
    expect(accepted).toHaveLength(6);
    expect(accepted.flatMap(candidate => candidate.evidenceRecords ?? []).flatMap(record => record.normalized.evidenceUnits ?? []).length)
      .toBeGreaterThan(2_048);
    const retained = selectGamingHybridAcceptedEvidence(request, accepted, actor);
    expect(retained.materialConflict).toBe(true);
    expect(selectGamingHybridEvidence(request, retained)).toMatchObject({ materialConflict: true, selectedEvidenceIds: [], coverageSatisfied: false });
  });

  it('admits an intact explicitly requested facet below the whole-question lexical floor only in v2', async () => {
    mockHttp.mockImplementation(async () => ({ status: 200, headers: { 'content-type': 'text/html' },
      data: `<html><title>Lantern Voyage guide</title><body><article>Lantern Voyage guide. Open amber gate using the copper switch beside the lantern.
        This intact source explains the opening procedure in Lantern Voyage and the safe timing for the switch, preserving the action and prerequisite.</article></body></html>` }));
    const request = { ...input, prompt: 'Open amber gate and cross crystal bridge and repair silver lever and unlock violet tower and activate ruby portal and collect golden compass',
      candidates: [{ url }] };
    const legacy = await evaluateGamingHybridCandidates(request, actor);
    expect(legacy.accepted).toHaveLength(0);
    const evaluated = await evaluateGamingHybridCandidates({ ...request, protocolVersion: 'gaming-hybrid-v2' }, actor);
    expect(evaluated.accepted).toHaveLength(1);
    const selected = selectGamingHybridEvidence(request, evaluated.knowledge);
    expect(selected.coverageSatisfied).toBe(false);
    expect(selected.requirementSupport[0].evidenceIds).toHaveLength(1);
    expect(selected.missingCoverage).toHaveLength(5);
  });

  it('does not refund failed acquisition elapsed work, and supplies a bounded remaining deadline', async () => {
    const started = Date.now();
    let clock = started;
    const time = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const resolveDocument = jest.fn<any>().mockImplementation(async (_url: string, _limit: number, options: any) => {
      expect(options.deadlineAt).toBe(started + 900);
      expect(options.timeoutMs).toBeLessThanOrEqual(900);
      clock += 700;
      throw new GamingDocumentAcquisitionError('SOURCE_INACCESSIBLE', 'transport', 'HTTP_RESPONSE_UNUSABLE', 0, 403);
    });
    try {
      const evaluated = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2', candidates: [{ url }] },
        { ...actor, maxElapsedMs: 900 }, { resolveDocument });
      expect(evaluated.acquisitionWorkMs).toBe(700);
      expect(evaluated.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['SOURCE_INACCESSIBLE'] }]);
      expect(JSON.stringify(evaluated.decisions)).not.toMatch(/robots/iu);
    } finally { time.mockRestore(); }
  });

  it('known unsupported format remains denied with an honest format reason in v2', async () => {
    const evaluated = await evaluateGamingHybridCandidates({ ...input, protocolVersion: 'gaming-hybrid-v2',
      candidates: [{ url: 'https://video.example.org/guide.mp4' }] }, actor);
    expect(evaluated.decisions).toMatchObject([{ decision: 'rejected', reasonCodes: ['UNSUPPORTED_SOURCE_FORMAT'] }]);
    expect(evaluated.accepted).toEqual([]);
  });
});
