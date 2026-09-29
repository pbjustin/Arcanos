// eslint-disable-next-line no-restricted-imports -- Actual pure section core only; no private composition CLI or input graph.
import { instructionSectionMap, transformInstructionSections } from '../../../scripts/skill-composition-core.mjs';

const FAILURE = 'GAMING_COMPOSITION_PREVIEW_ASSERTION_FAILED';
const header = '# Synthetic π😀\n\n';
const sourceParagraphs = [
  'Synthetic π😀 queryGamingHybridKnowledge twice: queryGamingHybridKnowledge.',
  'Synthetic canaryArcanosGaming and queryArcanosGaming.',
  'Synthetic submitGamingHybridCandidates; getGamingSourceIngestionStatus.',
  'Synthetic ingestGamingSources; refreshGamingSources; ingestGamingHybridCandidates.',
  'Synthetic preserved ✓.',
];
// Independent expected wording, never derived by applying the transformation under test.
const outputParagraphs = [
  'Synthetic π😀 arcanos_gaming_hybrid_query twice: arcanos_gaming_hybrid_query.',
  'Synthetic arcanos_gaming_canary and arcanos_gaming_query.',
  'Synthetic arcanos_gaming_submit_candidates; arcanos_gaming_ingestion_status.',
  'Synthetic arcanos_gaming_ingest_sources; arcanos_gaming_refresh_sources; arcanos_gaming_ingest_candidates.',
  'Synthetic preserved ✓.',
];
// Synthetic substitutions exercise the shared algorithm, not the private Gaming adapter's rules.
const operations = [
  ['queryArcanosGaming', 'arcanos_gaming_query'],
  ['canaryArcanosGaming', 'arcanos_gaming_canary'],
  ['queryGamingHybridKnowledge', 'arcanos_gaming_hybrid_query'],
  ['submitGamingHybridCandidates', 'arcanos_gaming_submit_candidates'],
  ['getGamingSourceIngestionStatus', 'arcanos_gaming_ingestion_status'],
  ['ingestGamingSources', 'arcanos_gaming_ingest_sources'],
  ['refreshGamingSources', 'arcanos_gaming_refresh_sources'],
  ['ingestGamingHybridCandidates', 'arcanos_gaming_ingest_candidates'],
] as const;
const transformations = operations.map(([oldAction, mcpOperation]) => ({
  id: `synthetic-${mcpOperation}`, oldAction, mcpOperation,
  pattern: new RegExp(`\\b${oldAction}\\b`, 'gu'), replacement: mcpOperation,
  reason: 'Synthetic Gaming operation mapping.', intendedEffect: 'Exercise shared transformation trace.',
}));
const traceCounts = [[[2, 2]], [[0, 1], [1, 1]], [[3, 1], [4, 1]], [[5, 1], [6, 1], [7, 1]], []];
const fixtures = [
  {
    separator: '\n\n',
    spans: [[0, 80, 20, 102], [80, 135, 102, 161], [135, 208, 161, 239], [208, 292, 239, 347], [292, 316, 347, 371]],
    sourceHashes: [
      '33a12dda88b18f5db5e86d32ca4e2d6f56c18e2cdf0cd445ca5e3a1d098de03e', // gitleaks:allow -- synthetic SHA-256
      'b24d837a9c5b41c1c544269e8994c8678e0d2446d5f64a278e97bf51f9f7af95', // gitleaks:allow -- synthetic SHA-256
      'a1372fbc0af003964c98e0f60f343d7e59ef8ed0362a0f0c51af7814306ba312', // gitleaks:allow -- synthetic SHA-256
      '2cd37b5425c6ef406297461905929cdf8cca4f07dbee9fc20d829568811b5d2e', // gitleaks:allow -- synthetic SHA-256
      '8dcff19883379dd7ac5b109fdba33885d6116b62a7b6f65fb80eacf6e7c352ea', // gitleaks:allow -- synthetic SHA-256
    ],
    outputHashes: [
      '177a22adc44f2d1b05e02b6b16d1e247edc8ba97b7dcd7a1bd9c4d53801adc1e', // gitleaks:allow -- synthetic SHA-256
      'e0bf12d0dd778efa5ce66e0b4ef3dbb38a655d27174914f3dbabf0321bae9a87', // gitleaks:allow -- synthetic SHA-256
      '3ed9dbd5218e271ae06233f5edea48628a1b064f064448c7f5177b2968ba8373', // gitleaks:allow -- synthetic SHA-256
      '941e1673c28a2bd0ab9e613aada84d914da7fec3b38a46a42a20edd5bcfd8b78', // gitleaks:allow -- synthetic SHA-256
      '8dcff19883379dd7ac5b109fdba33885d6116b62a7b6f65fb80eacf6e7c352ea', // gitleaks:allow -- synthetic SHA-256
    ],
  },
  {
    separator: '\r\n\r\n',
    spans: [[0, 82, 20, 104], [82, 139, 104, 165], [139, 214, 165, 245], [214, 300, 245, 355], [300, 324, 355, 379]],
    sourceHashes: [
      '2caaf37ffe478fef553c5a78ec2de6f87b392c2a6c83686f457fb1d41f78f093', // gitleaks:allow -- synthetic SHA-256
      '31d2b4d63ca5a1b319bef615a602525d5ba590df6ea40bef8f21947f09b2e59b', // gitleaks:allow -- synthetic SHA-256
      '4311428c1768ce320b6d1fe8998a41976d252acfc64a63fc4fe296b192a8e32d', // gitleaks:allow -- synthetic SHA-256
      'a4c0c7ddc4c9776a0d02eee381dad216334188e86aa8458b00514a9432eef575', // gitleaks:allow -- synthetic SHA-256
      '8dcff19883379dd7ac5b109fdba33885d6116b62a7b6f65fb80eacf6e7c352ea', // gitleaks:allow -- synthetic SHA-256
    ],
    outputHashes: [
      'b8637ccb6a80354814e61ad1e1580b34c42da28c6e0d7fba5151f7837381e90a', // gitleaks:allow -- synthetic SHA-256
      '4b28b96ab5f84139eff384eb4fd1ba7d1b8bee4cb9c3d18bc8975297053e9efb', // gitleaks:allow -- synthetic SHA-256
      '9e89f0d1a46aa65da28b80dde1cc1aa0d194bbc05dd6ca6f587275b8f05bea65', // gitleaks:allow -- synthetic SHA-256
      '4663394d54ca00bce8ec5a4699585e6ef97f0746b6c5bfea558e6d93e18779a6', // gitleaks:allow -- synthetic SHA-256
      '8dcff19883379dd7ac5b109fdba33885d6116b62a7b6f65fb80eacf6e7c352ea', // gitleaks:allow -- synthetic SHA-256
    ],
  },
];

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}
function requireSectionLimit(action: () => unknown): void {
  let rejected = false;
  try { action(); } catch (error) {
    requireProof(error instanceof Error && error.message === 'TOO_MANY_INSTRUCTION_SECTIONS');
    rejected = true;
  }
  requireProof(rejected);
}

/**
 * Executes the existing shared section mapper with finite server-owned Gaming
 * substitutions. This does not compose or inspect a private skill, execute the
 * Gaming adapter's full transformations, or establish owner, package or release approval.
 */
export function assertGamingCompositionPreviewFixture(): void {
  try {
    requireProof(Buffer.byteLength(header, 'utf8') === 20);
    for (const fixture of fixtures) {
      const source = sourceParagraphs.join(fixture.separator);
      const expectedContent = outputParagraphs.join(fixture.separator);
      const sourceBytes = Buffer.from(source, 'utf8');
      const outputBytes = Buffer.from(header + expectedContent, 'utf8');
      const sourceMap = instructionSectionMap(source, 20);
      const result = transformInstructionSections(source, 20, transformations, 'gaming-fixture-section');
      requireProof(result.content === expectedContent && sourceMap.length === 5 && result.sections.length === 5);
      requireProof(JSON.stringify(result) === JSON.stringify(
        transformInstructionSections(source, 20, transformations, 'gaming-fixture-section')));
      requireProof(result.sections.map(section => section.sourceText).join('') === source);
      requireProof(result.sections.map(section => section.transformedText).join('') === expectedContent);
      for (let index = 0; index < fixture.spans.length; index += 1) {
        const [sourceStartByte, sourceEndByte, outputStartByte, outputEndByte] = fixture.spans[index];
        const suffix = String(index + 1).padStart(3, '0');
        const original = sourceMap[index];
        const section = result.sections[index];
        requireProof(original.sourceId === `instruction-section-${suffix}` && original.targetId === `teaching-core-section-${suffix}`
          && original.sourceStartByte === sourceStartByte && original.sourceEndByte === sourceEndByte
          && original.outputStartByte === sourceStartByte + 20 && original.outputEndByte === sourceEndByte + 20
          && original.sha256 === fixture.sourceHashes[index]);
        requireProof(section.sourceId === original.sourceId && section.targetId === `gaming-fixture-section-${suffix}`
          && section.sourceStartByte === sourceStartByte && section.sourceEndByte === sourceEndByte
          && section.outputStartByte === outputStartByte && section.outputEndByte === outputEndByte
          && section.sha256 === fixture.sourceHashes[index] && section.outputSha256 === fixture.outputHashes[index]);
        requireProof(sourceBytes.subarray(sourceStartByte, sourceEndByte).equals(Buffer.from(section.sourceText, 'utf8'))
          && outputBytes.subarray(outputStartByte, outputEndByte).equals(Buffer.from(section.transformedText, 'utf8')));
        const expectedTrace = traceCounts[index].map(([operation, count]) => ({
          id: transformations[operation].id, count, reason: 'Synthetic Gaming operation mapping.',
          intendedEffect: 'Exercise shared transformation trace.', oldAction: operations[operation][0], mcpOperation: operations[operation][1],
        }));
        requireProof(JSON.stringify(section.transformations) === JSON.stringify(expectedTrace)
          && section.disposition === (index === 4 ? 'PRESERVED' : 'TRANSFORMED'));
      }
      requireProof(result.sections[4].sourceEndByte === sourceBytes.length && result.sections[4].outputEndByte === outputBytes.length);
    }
    const limitSource = Array.from({ length: 512 }, () => 'x').join('\n\n');
    const atLimit = instructionSectionMap(limitSource, 20);
    const transformedLimit = transformInstructionSections(limitSource, 20, [], 'gaming-fixture-section');
    requireProof(atLimit.length === 512 && transformedLimit.sections.length === 512 && transformedLimit.content === limitSource);
    for (let index = 0; index < 512; index += 1) {
      const end = index * 3 + (index === 511 ? 1 : 3);
      const section = atLimit[index];
      const transformed = transformedLimit.sections[index];
      requireProof(section.sourceStartByte === index * 3 && section.sourceEndByte === end
        && section.outputStartByte === index * 3 + 20 && section.outputEndByte === end + 20);
      requireProof(transformed.sourceStartByte === index * 3 && transformed.sourceEndByte === end
        && transformed.outputStartByte === index * 3 + 20 && transformed.outputEndByte === end + 20
        && transformed.disposition === 'PRESERVED' && transformed.transformations.length === 0);
    }
    const tooMany = `${limitSource}\n\nx`;
    requireSectionLimit(() => instructionSectionMap(tooMany, 20));
    requireSectionLimit(() => transformInstructionSections(tooMany, 20, [], 'gaming-fixture-section'));
  } catch {
    throw new Error(FAILURE);
  }
}
