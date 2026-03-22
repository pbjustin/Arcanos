import { createArcanosTrinityModule } from './arcanosTrinityModule.js';

export const ArcanosAudit = createArcanosTrinityModule({
  name: 'ARCANOS:AUDIT',
  description: 'Audit and evaluation module routed through the Trinity pipeline.',
  gptIds: ['arcanos-audit', 'audit'],
  sourceEndpoint: 'audit',
  mockEndpoint: 'gpt/arcanos-audit'
});

export default ArcanosAudit;
