import { Router, type RequestHandler } from 'express';
import apiArcanosRouter from "@routes/api-arcanos.js";
import apiSimRouter from "@routes/api-sim.js";
import apiMemoryRouter from "@routes/api-memory.js";
import apiSaveConversationRouter from "@routes/api-save-conversation.js";
import apiCodebaseRouter from "@routes/api-codebase.js";
import apiCommandsRouter from "@routes/api-commands.js";
import apiControlPlaneRouter from "@routes/api-control-plane.js";
import apiAssistantsRouter from "@routes/api-assistants.js";
import apiVisionRouter from "@routes/api-vision.js";
import apiTranscribeRouter from "@routes/api-transcribe.js";
import apiUpdateRouter from "@routes/api-update.js";
import apiDaemonRouter from "@routes/api-daemon.js";
import apiAgentRouter from "@routes/api-agent.js";
import apiPromptDebugRouter from "@routes/api-prompt-debug.js";
import apiAiRoutingDebugRouter from "@routes/api-ai-routing-debug.js";
import reusableCodeRouter from "@routes/api-reusable-code.js";
import prAnalysisRouter from "@routes/pr-analysis.js";
import openaiRouter from "@routes/openai.js";
import afolRouter from "@routes/afol.js";
import webSearchRouter from "@routes/web-search.js";
import { memoryConsistencyGate } from "@transport/http/middleware/memoryConsistencyGate.js";
import { requireMemoryPlaneAuth } from "@transport/http/middleware/memoryPlaneAuth.js";
import { isDagHttpRequestPath } from "@services/controlPlane/dagHttpBoundary.js";
import { isCefCommandReadRequest } from '@services/controlPlane/cefHttpBoundary.js';
import { isAfolReadRequest } from '@services/controlPlane/afolHttpBoundary.js';

const router = Router();
const routeDagControlPlane: RequestHandler = (req, res, next) => {
  if (!isDagHttpRequestPath(req)) {
    next();
    return;
  }

  apiArcanosRouter(req, res, next);
};
const routeCefCommandRead: RequestHandler = (req, res, next) => {
  if (!isCefCommandReadRequest(req)) {
    next();
    return;
  }

  apiCommandsRouter(req, res, next);
};
const routeAfolRead: RequestHandler = (req, res, next) => {
  if (!isAfolReadRequest(req)) {
    next();
    return;
  }

  afolRouter(req, res, next);
};

// The control plane is not part of the writing-plane consistency/reroute flow.
router.use('/api/control-plane', apiControlPlaneRouter);
// Daemon heartbeat/command transport is also control-plane traffic. Its router
// applies rate limiting and purpose-bound authentication before every handler.
router.use('/', apiDaemonRouter);
// Repository and prompt-trace inspection are read-only control-plane surfaces.
// Their leaf routers authenticate, authorize, and terminate unknown subpaths.
router.use('/api/codebase', apiCodebaseRouter);
router.use('/api/prompt-debug', apiPromptDebugRouter);
router.use('/', apiAiRoutingDebugRouter);
// PR verification is control-plane work. Its execution leaf applies a stricter
// operator boundary while health, schema, and the inert webhook retain their
// existing public contracts.
router.use('/api/pr-analysis', prAnalysisRouter);
// DAG traffic is already authenticated at the application ingress and again
// inside its leaf router. Dispatch it before the writing-plane consistency gate
// so that control-plane methods and paths can never be rewritten as GPT work.
router.use('/api/arcanos', routeDagControlPlane);
// Command registry reads are authenticated control-plane inspection. Dispatch
// them before the writing-plane gate so a read scope can never be rewritten
// into GPT execution. Command and agent POSTs remain behind the gate.
router.use('/api/commands', routeCefCommandRead);
// AFOL health and retained-record inspection are control-plane reads. Dispatch
// them before writing-plane consistency; provider-backed POST /decide retains
// the Trinity gate and its exact strict-block binding.
router.use('/api/afol', routeAfolRead);
// Assistant-registry reads and confirmed synchronization are direct
// control-plane operations and must never enter writing-plane rerouting.
router.use('/api/assistants', apiAssistantsRouter);
router.use('/api/memory', requireMemoryPlaneAuth);
router.use('/api/save-conversation', requireMemoryPlaneAuth);
router.use(memoryConsistencyGate);

router.use('/', apiSaveConversationRouter);
router.use('/api/arcanos', apiArcanosRouter);
router.use('/api/sim', apiSimRouter);
router.use('/api/memory', apiMemoryRouter);
router.use('/api/commands', apiCommandsRouter);
router.use('/api/openai', openaiRouter);
router.use('/api/afol', afolRouter);
router.use('/', apiAgentRouter);
router.use('/', apiVisionRouter);
router.use('/', apiTranscribeRouter);
router.use('/', apiUpdateRouter);
router.use('/', reusableCodeRouter);
router.use('/', webSearchRouter);

export default router;
