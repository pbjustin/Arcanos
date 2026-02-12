import { Router } from 'express';
import researchRouter from './research.js';
import workersRouter from './workers.js';
import initRouter from './init.js';
import diagnosticsRouter from "./diagnostics.js";

const router = Router();

router.use('/', researchRouter);
router.use('/', workersRouter);
router.use('/', initRouter);
router.use('/', diagnosticsRouter);

export default router;
