import type { GamingUniversalIdentityFixture } from './gaming-universal-identity.js';

/** Independent, invented game documents. None belongs to a production registry. */
export const gamingIndependentWorkflowFixtures: readonly GamingUniversalIdentityFixture[] = [
  { id: 'independent-prism', game: 'Velvet Meridian', genre: 'synthetic unknown', topic: 'Prism Lacing', mode: 'guide',
    question: 'How do I practice prism lacing?', unrelatedGame: 'Velvet Meridian Echoes',
    sentences: ['Practice prism lacing by aligning a quiet prism with the vacant ribbon socket.',
      'Turn the prism once and release the ribbon when its fringe becomes silver.',
      'Leave the ribbon socket vacant until the prism stops humming.'] },
  { id: 'independent-echoes', game: 'Velvet Meridian Echoes', genre: 'synthetic unknown', topic: 'Fringe Folding', mode: 'guide',
    question: 'How do I practice fringe folding?', unrelatedGame: 'Velvet Meridian',
    sentences: ['Practice fringe folding by arranging the loose fringe beside a silent mirror.',
      'Fold the fringe once when the mirror turns opaque and preserve the vacant fold.',
      'Inspect the fringe after the mirror becomes clear before beginning another fold.'] },
  { id: 'independent-word', game: 'Drift', genre: 'synthetic ordinary word', topic: 'Cloud Stitching', mode: 'guide',
    question: 'How do I practice cloud stitching?', unrelatedGame: 'Drift Echoes',
    sentences: ['Practice cloud stitching by placing a hollow needle beside the still cloud.',
      'Stitch once when the cloud edge becomes violet and withdraw the hollow needle.',
      'Leave the cloud still until the violet edge disappears.'] },
  { id: 'independent-subtitle', game: 'Aurora Atlas IV: The Quiet Tide', genre: 'synthetic subtitle', topic: 'Tide Notation', mode: 'guide',
    question: 'How do I practice tide notation?', unrelatedGame: 'Aurora Atlas V: The Quiet Tide',
    sentences: ['Practice tide notation by placing a blank slate beside the silent tide gauge.',
      'Mark the slate once when the tide gauge becomes amber and preserve its remaining space.',
      'Inspect the tide notation before marking another amber interval.'] }
];
