import { createResearchRouter } from './_core/researchRoute.js';

const researchRouter = createResearchRouter({
  path: '/commands/research',
  bridgeName: 'ROUTE:RESEARCH',
});

export default researchRouter;
