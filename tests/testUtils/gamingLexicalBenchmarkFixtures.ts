import { createHash } from 'node:crypto';
import type { GamingStoredEvidenceRecord, GamingStoredKnowledgeInput } from '../../src/shared/gaming/gamingStoredEvidenceCore.js';
import { GAMING_FRESHNESS_POLICY_VERSION } from '../../src/shared/gaming/gamingFreshnessCore.js';

export const GAMING_LEXICAL_BENCHMARK_VERSION = 'gaming-lexical-selection/v1';
export const GAMING_LEXICAL_BENCHMARK_DATE = '2026-11-08T12:00:00.000Z';
export const GAMING_LEXICAL_BENCHMARK_BASE_SHA = 'eea2d0b6ed72d00e3489a9f8ddf45335b3aa1e86';
const unknownGame = 'Lumenfall: Glass Harbor';

// Authored synthetic passages and relevance judgments, never captured publisher
// material or statements of real gameplay truth. Fixed positive ranks isolate
// the production post-query lexical selector from PostgreSQL ranking.
const passages = [
  { id: 'load', game: 'Elden Ring', text: 'Equipment load determines the roll category. Keep equipment load below the heavy threshold to avoid heavy rolling.' },
  { id: 'stamina', game: 'Elden Ring', text: 'Stamina recovery restores the stamina meter when you stop attacking. Lower the shield to restore stamina between attacks.' },
  { id: 'poise', game: 'Elden Ring', text: 'Poise determines whether an incoming hit interrupts an action. Equip armor with more poise to resist interruption.' },
  { id: 'craft', game: 'Minecraft', text: 'Craft a crafting table by placing four wooden planks in the inventory crafting grid. Use the crafting table to open the larger crafting grid.' },
  { id: 'shield', game: 'The Legend of Zelda: Ocarina of Time', text: 'The Deku Shield is sold at Kokiri Shop for 40 Rupees. Buy the Deku Shield before entering the Deku Tree.' },
  { id: 'bridge', game: unknownGame, text: 'Repair the copper bridge by replacing the damaged planks. Collect the planks beside Copper Quay and fit them into the bridge supports.' },
  { id: 'gate', game: unknownGame, text: 'Open the amber gate by pulling the blue lever beside the gate. The lever is found beneath the eastern stairs.' },
  { id: 'weapon', game: unknownGame, text: 'The Blade of Wind and Rain is sold by the harbor merchant. Collect six copper tokens and buy the Blade of Wind and Rain.' }
] as const;

function makeRecord(id: string, game: string, text: string, overrides: Partial<GamingStoredEvidenceRecord> = {}): GamingStoredEvidenceRecord {
  const contentHash = createHash('sha256').update(text).digest('hex');
  return { gameName: game, recordId: id, sourceId: `source-${id}`, revisionId: `revision-${id}-1`,
    publicUrl: `https://guides.example.org/lexical-benchmark/${id}`, sourceType: 'supplied', recordType: 'guide',
    title: `${game} gameplay instructions`, searchText: text, normalized: { text }, contentHash,
    fetchedAt: new Date(GAMING_LEXICAL_BENCHMARK_DATE), publishedAt: new Date('2026-10-01T12:00:00.000Z'),
    provenance: { edition: 'base-game', classification: 'verified', generationEligible: true,
      acquiredApplicability: { extractorVersion: GAMING_FRESHNESS_POLICY_VERSION, contentHash, game,
        edition: 'base-game', platforms: ['PC'] }, resolverId: 'synthetic-benchmark', resolverVersion: '1' },
    relevance: 1, ...overrides };
}

export const gamingLexicalBenchmarkRecords: GamingStoredEvidenceRecord[] = passages.map(passage =>
  makeRecord(passage.id, passage.game, `In the game ${passage.game}, ${passage.text}`));
const load = gamingLexicalBenchmarkRecords[0];
const editionDistractor = makeRecord('foreign-edition', 'Elden Ring', 'Equipment load determines the roll category.');
editionDistractor.provenance.edition = 'DLC';
(editionDistractor.provenance.acquiredApplicability as Record<string, unknown>).edition = 'DLC';
gamingLexicalBenchmarkRecords.push(
  makeRecord('foreign', 'Hades', 'In the game Hades, equipment load determines the roll category.'),
  editionDistractor,
  makeRecord('foreign-platform', 'Elden Ring', load.searchText,
    { provenance: { ...load.provenance, acquiredApplicability: { ...load.provenance.acquiredApplicability as object, platforms: ['PS5'] } } }),
  makeRecord('unverified', 'Elden Ring', load.searchText,
    { provenance: { ...load.provenance, classification: 'unverified', generationEligible: false } }),
  makeRecord('reference', 'Elden Ring', load.searchText,
    { provenance: { ...load.provenance, classification: 'reference_only', generationEligible: false } }),
  makeRecord('revoked', 'Elden Ring', load.searchText,
    { authorityReassessmentRequired: true }),
  makeRecord('old-patch', 'Elden Ring', load.searchText)
);

export interface GamingLexicalBenchmarkCase {
  id: string;
  kind: 'exact' | 'paraphrase' | 'multi-source' | 'authority';
  input: GamingStoredKnowledgeInput;
  relevantIds: string[];
  rationale: string;
  recordIds?: string[];
}
const request = (game: string, prompt: string): GamingStoredKnowledgeInput => ({ game, prompt,
  mode: 'guide', edition: 'base-game', platform: 'PC', spoilerMode: 'none', requireRequestCoverage: true, limit: 3 });

export const gamingLexicalBenchmarkCases: GamingLexicalBenchmarkCase[] = [
  { id: 'named-load', kind: 'exact', input: request('Elden Ring', 'Explain equipment load.'), relevantIds: ['load'],
    rationale: 'The passage directly explains the named mechanic and the heavy-roll consequence.' },
  { id: 'named-stamina', kind: 'exact', input: request('Elden Ring', 'Explain stamina recovery.'), relevantIds: ['stamina'],
    rationale: 'The passage directly explains the named recovery mechanic and a recovery action.' },
  { id: 'named-poise', kind: 'exact', input: request('Elden Ring', 'Explain poise.'), relevantIds: ['poise'],
    rationale: 'The passage directly explains the named interruption-resistance mechanic.' },
  { id: 'named-crafting', kind: 'exact', input: request('Minecraft', 'How do I craft a crafting table?'), relevantIds: ['craft'],
    rationale: 'The passage supplies the materials, quantity and crafting procedure.' },
  { id: 'named-shield', kind: 'exact', input: request('The Legend of Zelda: Ocarina of Time', 'Where is the Deku Shield sold?'), relevantIds: ['shield'],
    rationale: 'The passage binds the named shield to its shop and purchase price.' },
  { id: 'unknown-bridge', kind: 'exact', input: request(unknownGame, 'How do I repair the copper bridge?'), relevantIds: ['bridge'],
    rationale: 'The unfamiliar title has exact acquired game identity and a bridge repair procedure.' },
  { id: 'unknown-gate', kind: 'exact', input: request(unknownGame, 'How do I open the amber gate?'), relevantIds: ['gate'],
    rationale: 'The unfamiliar title has a specific gate-opening procedure and location.' },
  { id: 'coordinated-name', kind: 'exact', input: request(unknownGame, 'How do I get the Blade of Wind and Rain?'), relevantIds: ['weapon'],
    rationale: 'A coordinated named weapon is one target; the passage supplies its merchant and cost.' },
  { id: 'load-paraphrase', kind: 'paraphrase', input: request('Elden Ring', 'Why does dodging feel sluggish?'), relevantIds: ['load'],
    rationale: 'Sluggish dodging asks about the heavy-roll consequence described using different terms.' },
  { id: 'poise-paraphrase', kind: 'paraphrase', input: request('Elden Ring', 'How can I resist stagger interruption?'), relevantIds: ['poise'],
    rationale: 'Resistance to stagger/interruption asks about the poise effect using alternate terminology.' },
  { id: 'bridge-paraphrase', kind: 'paraphrase', input: request(unknownGame, 'How can I restore the damaged crossing?'), relevantIds: ['bridge'],
    rationale: 'Restoring the damaged crossing asks for the bridge repair procedure with alternate nouns and verbs.' },
  { id: 'gate-paraphrase', kind: 'paraphrase', input: request(unknownGame, 'How can I unlock the entrance?'), relevantIds: ['gate'],
    rationale: 'Unlocking the entrance asks for the gate procedure with no exact mechanic-token overlap.' },
  { id: 'two-mechanics', kind: 'multi-source', input: request('Elden Ring', 'Explain equipment load and stamina recovery.'), relevantIds: ['load', 'stamina'],
    rationale: 'The independent mechanic questions require complementary passages, both with exact named support.' },
  { id: 'two-procedures', kind: 'multi-source', input: request(unknownGame, 'How do I repair the copper bridge? Also tell me how to open the amber gate.'), relevantIds: ['bridge', 'gate'],
    rationale: 'Two independent procedures require both specific authored instructions rather than source count alone.' },
  { id: 'authority-isolation', kind: 'authority', input: request('Elden Ring', 'Explain equipment load.'),
    relevantIds: ['load'], recordIds: ['load', 'foreign', 'foreign-edition', 'foreign-platform', 'unverified', 'reference', 'revoked'],
    rationale: 'Only the compatible verified passage may support the named mechanic; attractive lexical distractors remain excluded.' }
];
