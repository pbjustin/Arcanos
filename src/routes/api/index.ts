import { Router } from 'express';
import apiArcanosRouter from "@routes/api-arcanos.js";
import apiSimRouter from "@routes/api-sim.js";
import apiMemoryRouter from "@routes/api-memory.js";
import apiSaveConversationRouter from "@routes/api-save-conversation.js";
import apiCodebaseRouter from "@routes/api-codebase.js";
import apiCommandsRouter from "@routes/api-commands.js";
import apiAssistantsRouter from "@routes/api-assistants.js";
import apiVisionRouter from "@routes/api-vision.js";
import apiTranscribeRouter from "@routes/api-transcribe.js";
import apiUpdateRouter from "@routes/api-update.js";
import apiDaemonRouter from "@routes/api-daemon.js";
import apiAgentRouter from "@routes/api-agent.js";
import reusableCodeRouter from "@routes/api-reusable-code.js";
import prAnalysisRouter from "@routes/pr-analysis.js";
import openaiRouter from "@routes/openai.js";
import afolRouter from "@routes/afol.js";
import webSearchRouter from "@routes/web-search.js";
import { memoryConsistencyGate } from "@transport/http/middleware/memoryConsistencyGate.js";

const router = Router();

router.use(memoryConsistencyGate);

router.use('/', apiSaveConversationRouter);
router.use('/api/arcanos', apiArcanosRouter);
router.use('/api/sim', apiSimRouter);
router.use('/api/memory', apiMemoryRouter);
router.use('/api/codebase', apiCodebaseRouter);
router.use('/api/commands', apiCommandsRouter);
router.use('/api/pr-analysis', prAnalysisRouter);
router.use('/api/openai', openaiRouter);
router.use('/api/assistants', apiAssistantsRouter);
router.use('/api/afol', afolRouter);
router.use('/', apiAgentRouter);
router.use('/', apiVisionRouter);
router.use('/', apiTranscribeRouter);
router.use('/', apiUpdateRouter);
router.use('/', apiDaemonRouter);
router.use('/', reusableCodeRouter);
router.use('/', webSearchRouter);

export default router;
