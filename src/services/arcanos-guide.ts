import { createArcanosTrinityModule } from './arcanosTrinityModule.js';

export const ArcanosGuide = createArcanosTrinityModule({
  name: 'ARCANOS:GUIDE',
  description: 'Guidance module routed through the Trinity pipeline.',
  gptIds: ['arcanos-guide', 'guide'],
  sourceEndpoint: 'guide',
  mockEndpoint: 'gpt/arcanos-guide'
});

export default ArcanosGuide;
