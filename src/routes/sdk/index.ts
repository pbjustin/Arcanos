import { Router } from 'express';
import researchRouter from './research.js';
import workersRouter from './workers.js';
import initRouter from './init.js';
import diagnosticsRouter from "./diagnostics.js";
import {
  legacyOperatorHttpBoundary,
} from '@services/controlPlane/legacyOperatorHttpBoundary.js';
import {
  legacyOperatorBodyParser,
} from '@services/controlPlane/legacyOperatorBodyParser.js';

const router = Router();

router.use(legacyOperatorHttpBoundary);
router.use(legacyOperatorBodyParser);
router.use('/', researchRouter);
router.use('/', workersRouter);
router.use('/', initRouter);
router.use('/', diagnosticsRouter);

export default router;
