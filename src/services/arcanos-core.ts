import { createArcanosTrinityModule } from './arcanosTrinityModule.js';

export const ArcanosCore = createArcanosTrinityModule({
  name: 'ARCANOS:CORE',
  description: 'Primary ARCANOS entryway that routes prompt-first requests through the Trinity core pipeline.',
  gptIds: ['arcanos-core', 'core'],
  sourceEndpoint: 'gpt.arcanos-core.query',
  mockEndpoint: 'gpt/arcanos-core'
});

export default ArcanosCore;
