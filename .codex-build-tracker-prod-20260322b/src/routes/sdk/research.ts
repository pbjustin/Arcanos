import { createResearchRouter } from '../_core/researchRoute.js';

const sdkResearchRouter = createResearchRouter({
  path: '/research',
  bridgeName: 'SDK:RESEARCH',
  formatUrlValidationError: payload => ({
    success: false,
    ...payload,
  }),
});

export default sdkResearchRouter;
