import { describe, expect, it } from '@jest/globals';
import type { GamingEvidenceUnit } from '../src/shared/gaming/gamingEvidenceUnits.js';
import type { ResolvedGamingDocument } from '../src/services/gamingDocumentResolution.js';
import { assessGamingClearSource, gamingClearIntactSourceText } from '../src/shared/gaming/gamingClearSource.js';
import { assessGamingSourcePolicy, extractGamingFreshnessMetadata } from '../src/shared/gaming/gamingFreshnessCore.js';
import { gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import { assessGamingStructuralUsability } from '../src/shared/gaming/gamingStructuralEvidence.js';
import { chunkGamingDocument } from '../src/services/gamingDurableDocumentChunks.js';
import { formatStoredGamingEvidence, selectStoredGamingEvidence, type GamingStoredKnowledgeContext } from '../src/shared/gaming/gamingStoredEvidenceCore.js';
import { assessGamingClearEvidence } from '../src/shared/gaming/gamingClearEvidence.js';

const now = new Date('2026-09-10T12:00:00Z');
const url = 'https://guides.example.org/synthetic';
function locationUnit(fields: Record<string, string> = { System: 'T-1', Body: 'B 2', Site: 'S 7', Resource: 'Platinum' }): GamingEvidenceUnit {
  const entries = Object.entries(fields).map(([label, value]) => ({ label, value }));
  return { id: 'row-1', kind: 'table_row', text: `Testspace\n${entries.map(field => `${field.label}: ${field.value}`).join(' | ')}`,
    fields: entries, context: { scope: 'table-1/row-1', heading: 'Testspace' },
    provenance: { sourceUrl: url, strategy: 'html_table', policyVersion: 'gaming-evidence-units/v1', locator: 'table[0]/tr[1]', representation: 'html_dom' },
    integrity: { status: 'complete', reasons: [] } };
}
function document(unit: GamingEvidenceUnit, truncated = false): ResolvedGamingDocument {
  return { requestedUrl: url, canonicalUrl: url, publicUrl: url, host: 'guides.example.org', text: unit.text,
    metadata: { title: 'Testspace', headings: 'Testspace' },
    extraction: { strategy: 'article', rawTextLength: 200, cleanedTextLength: unit.text.length, navigationDensity: 0 },
    resolution: { resolverId: 'generic-web', resolverVersion: 'gaming-document-v1', strategy: 'article', documentType: 'html', supportsStructuredExtraction: false },
    metrics: { rawTextLength: 200, cleanedTextLength: unit.text.length, instructionFiltered: false, truncated },
    evidenceUnits: [unit] } as ResolvedGamingDocument;
}
function mixedKnowledge(prose: string, units: GamingEvidenceUnit[]): GamingStoredKnowledgeContext {
  const context = [prose, ...units.map(unit => unit.text)].join('\n\n');
  return { context, sources: [{ sourceId: 'source', url, game: 'Testspace', sourceType: 'unreviewed', fetchedAt: now.toISOString(), snippet: prose }],
    evidence: [{ sourceId: 'source', revisionId: 'revision', recordId: 'prose', recordType: 'guide', publicUrl: url,
      text: prose, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: now.toISOString() } },
    ...units.map((unit, index) => ({ sourceId: 'source', revisionId: 'revision', recordId: `row-${index}`, recordType: 'guide', publicUrl: url,
      text: unit.text, evidenceUnits: [unit], lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: now.toISOString() } }))] };
}

describe('structural evidence survives the existing CLEAR source gates', () => {
  it('admits a genuinely short labeled source report without a sentence-ending period', () => {
    const doc = document(locationUnit());
    expect(doc.text.length).toBeLessThan(120);
    expect(doc.text).not.toMatch(/[.!?]$/u);
    const input = { game: 'Testspace', prompt: 'Where is Platinum? Give system, body, site and resource.', mode: 'guide' as const };
    const result = assessGamingClearSource(input, doc, { subjectId: 'source', subjectHash: gamingClearHash(doc.text), actorScopeHash: gamingClearHash('caller'),
      sourcePolicy: assessGamingSourcePolicy(url, input.game), freshness: extractGamingFreshnessMetadata(doc, input, now), now });
    expect(result).toMatchObject({ decision: 'accept', qualityEligible: true, gates: { claimSupport: 'verified' } });
  });
  it('keeps a demonstrably complete structured row despite truncation elsewhere', () => {
    const unit = locationUnit();
    expect(gamingClearIntactSourceText(document(unit, true))).toBe(unit.text);
  });
  it('never turns ambiguous serialization into prose evidence when the response was complete', () => {
    const unit = { ...locationUnit({ System: 'T-1', Body: 'B 2', Site: 'PML 7', Resource: 'Platinum',
      Explanation: 'An ambiguous header relationship remains ambiguous despite this long explanatory sentence.' }),
    integrity: { status: 'ambiguous' as const, reasons: ['ambiguous_field_mapping'] } };
    expect(unit.text.length).toBeGreaterThan(120);
    expect(gamingClearIntactSourceText(document(unit))).toBe('');
    const mixed = { ...document(unit), text: `An intact unrelated prose paragraph.\n\n${unit.text}` };
    expect(gamingClearIntactSourceText(mixed)).toBe('An intact unrelated prose paragraph.');
    const input = { game: 'Testspace', prompt: 'Explain the Platinum report', mode: 'guide' as const };
    const doc = document(unit);
    expect(assessGamingClearSource(input, doc, { subjectId: 'source', subjectHash: gamingClearHash(doc.text),
      sourcePolicy: assessGamingSourcePolicy(url, input.game), freshness: extractGamingFreshnessMetadata(doc, input, now), now }).qualityEligible).toBe(false);
  });
  it.each([
    { License: 'CC-BY', Publisher: 'Example' },
    { System: 'OTHER-1', Body: 'A 1', Site: 'PML 1', Resource: 'Iron' }
  ])('preserves sufficient prose when a complementary unrelated table is present: %j', fields => {
    const unit = locationUnit(fields);
    const prose = 'Testspace guide. This community source reports Platinum at system T-1, body B 2, site PML 7. It is a source assertion and current applicability remains unverified. Always check local conditions before using this reported resource location.';
    const input = { game: 'Testspace', prompt: 'Which system body site reports Platinum?', mode: 'guide' as const };
    for (const units of [[], [unit]]) {
      const doc = { ...document(unit), text: [prose, ...units.map(row => row.text)].join('\n\n'), evidenceUnits: units };
      expect(assessGamingClearSource(input, doc, { subjectId: 'source', subjectHash: gamingClearHash(doc.text),
        sourcePolicy: assessGamingSourcePolicy(url, input.game), freshness: extractGamingFreshnessMetadata(doc, input, now), now }).qualityEligible).toBe(true);
      expect(assessGamingClearEvidence(input, mixedKnowledge(prose, units))).toMatchObject({ decision: 'accept', gates: { claimSupport: 'verified' } });
    }
  });
  it.each(['partial', 'ambiguous', 'qualified', 'generic-prose'] as const)('keeps %s from borrowing independent prose support at either CLEAR gate', variant => {
    const base = locationUnit({ System: 'T-1', Body: 'B 2', Site: 'PML 7', Resource: variant === 'qualified' ? 'Platinum; depleted' : variant === 'generic-prose' ? 'Iron' : 'Platinum' });
    const unit = variant === 'partial' || variant === 'ambiguous' ? { ...base, integrity: { status: variant, reasons: ['incomplete_record'] } } : base;
    const prose = variant === 'generic-prose'
      ? 'Testspace guide. Each system body site has a resource report. Source records describe the system body site and resource; check the source report before visiting a location. These system body site records are community reports.'
      : 'Testspace guide. This community source reports Platinum at system T-1, body B 2, site PML 7. Always check local conditions before using this reported resource location.';
    const input = { game: 'Testspace', prompt: 'Which system body site reports Platinum?', mode: 'guide' as const };
    const doc = { ...document(unit), text: `${prose}\n\n${unit.text}` };
    expect(assessGamingClearSource(input, doc, { subjectId: 'source', subjectHash: gamingClearHash(doc.text),
      sourcePolicy: assessGamingSourcePolicy(url, input.game), freshness: extractGamingFreshnessMetadata(doc, input, now), now }).qualityEligible).toBe(false);
    expect(assessGamingClearEvidence(input, mixedKnowledge(prose, [unit])).qualityEligible).toBe(false);
  });
});

describe('claim-specific structural scope and ordinary retrieval', () => {
  const prompt = 'Where is Platinum? Give system, body, site and resource.';
  const assess = (units: GamingEvidenceUnit[], question = prompt) => assessGamingStructuralUsability({ units, prompt: question, game: 'Testspace', mode: 'guide' });
  it.each(['Site', 'Body', 'Resource'])('preserves known fields but reports missing %s without exact support', field => {
    const fields: Record<string, string> = { System: 'T-1', Body: 'B 2', Site: 'S 7', Resource: 'Platinum' };
    delete fields[field];
    const result = assess([locationUnit(fields)]);
    expect(result.hasIntactUsableUnit).toBe(true);
    expect(result.claimSupported).toBe(false);
    expect(result.missingFields).toContain(field.toLowerCase());
  });
  it('does not combine three incomplete rows into one field tuple', () => {
    expect(assess([locationUnit({ System: 'T-1', Resource: 'Platinum' }), locationUnit({ Body: 'B 2', Resource: 'Platinum' }),
      locationUnit({ Site: 'S 7', Resource: 'Platinum' })]).claimSupported).toBe(false);
  });
  it('does not accept another resource using only matching requested field labels', () => {
    const wrong = locationUnit({ System: 'OTHER-1', Body: 'A 1', Site: 'PML 1', Resource: 'Iron' });
    expect(assess([wrong], 'Which system body PML site reports Platinum?').claimSupported).toBe(false);
    const partial = { ...locationUnit({ System: 'T-1', Body: 'B 2', Site: '', Resource: 'Platinum' }), id: 'partial',
      integrity: { status: 'partial' as const, reasons: ['incomplete_record'] } };
    expect(assess([partial, wrong], 'Which system body PML site reports Platinum?').claimSupported).toBe(false);
  });
  it('keeps a repeated body name in different systems distinct', () => {
    expect(assess([locationUnit({ System: 'T-1', Body: 'B 2', Site: 'S 7', Resource: 'Gold' }),
      locationUnit({ System: 'T-2', Body: 'B 2', Site: 'S 8', Resource: 'Platinum' })], 'Where is Platinum in system T-1, body B 2?').claimSupported).toBe(false);
  });
  it.each([
    ['Where is Platinum in system T-1, body B 2?', { System: 'T-2', Body: 'B 1', Site: 'PML 7', Resource: 'Platinum' }],
    ['Where is Platinum? System: T-1; Body: B 2; Site: PML 7', { System: 'T-2', Body: 'B 1', Site: 'PML 7', Resource: 'Platinum' }],
    ['Where is Platinum in system 1, body 2?', { System: '2', Body: '1', Site: 'PML 7', Resource: 'Platinum' }],
    ['Where is Platinum in system T-1 and body B 2?', { System: 'T-1', Body: 'B 7', Site: 'PML 2', Resource: 'Platinum' }],
    ['Where is Platinum in system:T-1, body:B 2?', { System: 'T-2', Body: 'B 1', Site: 'PML 7', Resource: 'Platinum' }],
    ['Where is Platinum in T-1?', { System: 'T-2', Body: 'B 1', Site: 'PML 7', Resource: 'Platinum' }]
  ])('requires complete requested identifiers in their specified fields: %s', (question, fields) => {
    expect(assess([locationUnit(fields)], question).claimSupported).toBe(false);
  });
  it('keeps correctly scoped explicit identifiers usable', () => {
    expect(assess([locationUnit()], 'Where is Platinum in system T-1, body B 2?').claimSupported).toBe(true);
    expect(assess([locationUnit()], 'Where is Platinum? System:T-1; Body:B 2; Site:S 7').claimSupported).toBe(true);
  });
  it.each(['not Platinum', 'Platinum; depleted', 'Platinum; unconfirmed', 'Platinum; old patch', 'Platinum; example only', 'Platinum; no longer available', 'Platinum; correction'])('retains %s without treating it as an affirmative location', value => {
    const unit = locationUnit({ System: 'T-1', Body: 'B 2', Site: 'S 7', Resource: value });
    expect(unit.text).toContain(value);
    expect(assess([unit])).toMatchObject({ hasIntactUsableUnit: true, claimSupported: false });
  });
  it.each(['heading', 'caption', 'attribution'] as const)('preserves an Example only %s as a material qualifier', field => {
    const original = locationUnit();
    const unit = { ...original, text: `Example only\n${original.text}`, context: { ...original.context, [field]: 'Example only' } };
    expect(assess([unit])).toMatchObject({ hasIntactUsableUnit: true, claimSupported: false, reasonCodes: ['QUALIFIED_RECORD_NOT_AFFIRMATIVE'] });
  });
  it('does not silently prefer matching JSON when visible source values contradict it', () => {
    const visible = locationUnit({ System: 'T-1', Body: 'B 2', Site: 'S 7', Resource: 'Gold' });
    const embedded = { ...locationUnit(), id: 'json-1', kind: 'structured_record' as const,
      provenance: { ...visible.provenance, strategy: 'json_ld' as const, representation: 'json_pointer' as const, jsonOnly: true } };
    expect(assess([visible, embedded])).toMatchObject({ claimSupported: false, reasonCodes: ['CONTRADICTORY_STRUCTURAL_RECORDS'] });
  });
  it('omits contradictory records before durable indexing even without a question', async () => {
    const one = locationUnit();
    const two = { ...locationUnit({ System: 'T-1', Body: 'B 2', Site: 'S 7', Resource: 'Iron' }), id: 'row-2' };
    const result = await chunkGamingDocument([one.text, two.text].join('\n\n'), { evidenceUnits: [one, two] });
    expect(result).toMatchObject({ chunks: [], documentTruncated: true, coverageStatus: 'partial' });
    expect(result.text).toContain('Platinum');
    expect(result.text).toContain('Iron');
  });
  it('does not treat an ambiguous or partial unit as complete', () => {
    for (const status of ['partial', 'ambiguous'] as const) expect(assess([{ ...locationUnit(), integrity: { status, reasons: ['incomplete_record'] } }])).toMatchObject({
      hasIntactUsableUnit: false, claimSupported: false });
  });
  it('supports labeled stat and patch shapes while retaining source numeric lexemes', () => {
    const stat = locationUnit({ Item: 'Axe', Stat: 'Weight', Value: '-0.0250', Unit: 'kg', Scope: 'Base edition' });
    expect(assess([stat], 'What is the Axe weight statistic?')).toMatchObject({ claimShape: 'statistic', claimSupported: true });
    expect(stat.text).toContain('-0.0250');
    const patch = locationUnit({ Mechanic: 'Shield', Before: '1.20', After: '1.25', Patch: '2.01' });
    expect(assess([patch], 'What changed for Shield in patch 2.01?')).toMatchObject({ claimShape: 'patch_change', claimSupported: true });
    const freshness = extractGamingFreshnessMetadata(document(patch), { game: 'Testspace' }, now);
    expect(freshness).toMatchObject({ patch: '2.01', authority: 'unreviewed', currentness: 'none' });
    expect(freshness.metadataUnverified).toBeUndefined();
    expect(freshness.mechanicValues).toBeUndefined();
    expect(assess([locationUnit({ Item: 'Body armor', Stat: 'Weight', Value: '12', Unit: 'kg', Scope: 'Base edition' })],
      'What is the body armor weight statistic?')).toMatchObject({ claimShape: 'statistic', claimSupported: true });
  });
  it('retains the complete unit through chunks, selected evidence, CLEAR, and citation context', async () => {
    const unit = locationUnit();
    const doc = document(unit);
    const chunks = await chunkGamingDocument(doc.text, { evidenceUnits: doc.evidenceUnits });
    expect(chunks.chunks).toHaveLength(1);
    expect(chunks.chunks[0]).toMatchObject({ text: unit.text, evidenceUnits: [unit], startChar: 0, endChar: unit.text.length });
    const input = { game: 'Testspace', prompt, mode: 'guide' as const, spoilerMode: 'none' as const };
    const limits = { chunkChars: 2_000, maxChunks: 8, maxSources: 3, maxContextChars: 8_000, structuredEvidenceChars: 8_000 };
    const chunk = chunks.chunks[0];
    const candidates = selectStoredGamingEvidence([{ gameName: 'Testspace', recordId: 'record', recordType: 'guide', title: 'Testspace', searchText: chunk.text,
      normalized: { text: chunk.text, evidenceUnits: chunk.evidenceUnits, chunk: { ordinal: 0, totalChunks: 1, startChar: 0, endChar: chunk.text.length } },
      sourceId: 'source', publicUrl: url, sourceType: 'unreviewed', revisionId: 'revision', fetchedAt: now, publishedAt: null, provenance: {}, relevance: 1 }], input, limits);
    const knowledge = formatStoredGamingEvidence(candidates, input, limits);
    expect(knowledge.evidence?.[0]).toMatchObject({ text: unit.text, evidenceUnits: [unit] });
    expect(knowledge.context).toContain('source location: table[0]/tr[1]');
    expect(assessGamingClearEvidence(input, knowledge)).toMatchObject({ decision: 'accept', gates: { claimSupport: 'verified' } });
    expect(formatStoredGamingEvidence(candidates, { maxContextChars: 60 }, limits).evidence).toBeUndefined();
  });
  it('keeps rows whole at a prose chunk boundary and skips over-budget records instead of clipping', async () => {
    const unit = locationUnit();
    const prose = 'Intact introductory sentence. '.repeat(63);
    const text = `${prose}\n\n${unit.text}\n\nEnd of document.`;
    const result = await chunkGamingDocument(text, { evidenceUnits: [unit] });
    expect(result.chunks.filter(chunk => chunk.evidenceUnits?.length)).toHaveLength(1);
    expect(result.chunks.find(chunk => chunk.evidenceUnits?.length)?.text).toBe(unit.text);
    for (const chunk of result.chunks) expect(chunk.text).toBe(result.text.slice(chunk.startChar, chunk.endChar));
    const large = locationUnit({ System: 'x'.repeat(900), Body: 'y'.repeat(900), Site: 'z'.repeat(900), Resource: 'Platinum' });
    const oversized = await chunkGamingDocument(large.text, { evidenceUnits: [large] });
    expect(oversized).toMatchObject({ chunks: [], coverageStatus: 'partial' });
  });
});
