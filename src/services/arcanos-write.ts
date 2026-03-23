import { createArcanosTrinityModule } from './arcanosTrinityModule.js';

export const ArcanosWrite = createArcanosTrinityModule({
  name: 'ARCANOS:WRITE',
  description: 'Content generation module routed through the Trinity pipeline.',
  gptIds: ['arcanos-write', 'write'],
  sourceEndpoint: 'write',
  mockEndpoint: 'gpt/arcanos-write'
});

export default ArcanosWrite;
