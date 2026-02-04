import { Router } from 'express';
import apiAskRouter from '../api-ask.js';
import apiArcanosRouter from '../api-arcanos.js';
import apiSimRouter from '../api-sim.js';
import apiMemoryRouter from '../api-memory.js';
import apiCodebaseRouter from '../api-codebase.js';
import apiCommandsRouter from '../api-commands.js';
import apiAssistantsRouter from '../api-assistants.js';
import apiVisionRouter from '../api-vision.js';
import apiTranscribeRouter from '../api-transcribe.js';
import apiUpdateRouter from '../api-update.js';
import apiDaemonRouter from '../api-daemon.js';
import reusableCodeRouter from '../api-reusable-code.js';
import prAnalysisRouter from '../pr-analysis.js';
import openaiRouter from '../openai.js';
import afolRouter from '../afol.js';

const router = Router();

router.use('/', apiAskRouter);
router.use('/api/arcanos', apiArcanosRouter);
router.use('/api/sim', apiSimRouter);
router.use('/api/memory', apiMemoryRouter);
router.use('/api/codebase', apiCodebaseRouter);
router.use('/api/commands', apiCommandsRouter);
router.use('/api/pr-analysis', prAnalysisRouter);
router.use('/api/openai', openaiRouter);
router.use('/api/assistants', apiAssistantsRouter);
router.use('/api/afol', afolRouter);
router.use('/', apiVisionRouter);
router.use('/', apiTranscribeRouter);
router.use('/', apiUpdateRouter);
router.use('/', apiDaemonRouter);
router.use('/', reusableCodeRouter);

export default router;
