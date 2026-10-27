import express from 'express';
import { createChatGptBookerMcpRouterCore } from './routes/chatgptBookerMcpCore.js';
import { bookerAuthChallenge, createBookerTokenVerifierCore, readBookerAuthConfigurationCore } from './chatgpt/bookerAuthCore.js';
import { BOOKER_MCP_PATH, BOOKER_METADATA_PATH } from './shared/chatgpt/bookerMcpContract.js';

export const BOOKER_REAL_AUTH_PREVIEW_CONFIG = Object.freeze({
  issuer: 'https://dev-etfsljoipfurdij6.us.auth0.com/',
  jwksUrl: 'https://dev-etfsljoipfurdij6.us.auth0.com/.well-known/jwks.json',
  oauthClientId: 'tpc_rDnRcT3dA8wyZwEAZ8wLCa', // gitleaks:allow -- public OAuth client identifier.
  universeId: 'booker-auth0-preview-1566',
});
export const BOOKER_REAL_AUTH_PREVIEW_EVIDENCE_PATH = '/chatgpt/booker/preview-evidence';
export const BOOKER_REAL_AUTH_PREVIEW_PROOF_HEADER = 'x-arcanos-preview-chatgpt-booker-version';
export const BOOKER_REAL_AUTH_PREVIEW_PROOF_VERSION = 'chatgpt-booker-auth0-discovery/v1';

/** Real issuer verification with no application services or tool execution authority. */
export function createBookerMcpRealAuthPreview({ origin, ownerSubject }: { origin: string; ownerSubject: string }) {
  const identity = /^https:\/\/[a-z0-9][a-z0-9-]*pr-([0-9a-f]{6})-1566[a-z0-9-]*\.up\.railway\.app$/u.exec(origin);
  if (!identity || identity[1] === '676861' || /(?:^|[.-])production(?:[.-]|$)/iu.test(new URL(origin).hostname)
    || typeof ownerSubject !== 'string' || ownerSubject.length === 0 || ownerSubject.length > 256
    || ownerSubject !== ownerSubject.trim() || /[\u0000-\u001f\u007f]/u.test(ownerSubject)) {
    throw new Error('BOOKER_REAL_AUTH_PREVIEW_CONFIGURATION_INVALID');
  }
  const configuration = readBookerAuthConfigurationCore(name => ({
    CHATGPT_BOOKER_ENABLED: 'true', CHATGPT_BOOKER_ISSUER: BOOKER_REAL_AUTH_PREVIEW_CONFIG.issuer,
    CHATGPT_BOOKER_RESOURCE: origin + BOOKER_MCP_PATH, CHATGPT_BOOKER_JWKS_URL: BOOKER_REAL_AUTH_PREVIEW_CONFIG.jwksUrl,
    CHATGPT_BOOKER_OWNER_SUBJECT: ownerSubject, CHATGPT_BOOKER_UNIVERSE_ID: BOOKER_REAL_AUTH_PREVIEW_CONFIG.universeId,
    CHATGPT_BOOKER_OAUTH_CLIENT_ID: BOOKER_REAL_AUTH_PREVIEW_CONFIG.oauthClientId,
  })[name]);
  if (configuration.status !== 'ready') throw new Error('BOOKER_REAL_AUTH_PREVIEW_CONFIGURATION_INVALID');
  // Omit keyResolver: the unchanged verifier fetches only the fixed issuer's public JWKS.
  const verification = { readEnvironmentValue: () => undefined };
  const verify = createBookerTokenVerifierCore(configuration, verification);
  let executorDenials = 0;
  let providerBoundaryDenials = 0;
  const router = express.Router();
  router.use((req, res, next) => {
    if ([BOOKER_MCP_PATH, BOOKER_METADATA_PATH, BOOKER_REAL_AUTH_PREVIEW_EVIDENCE_PATH].includes(req.path)) {
      res.setHeader(BOOKER_REAL_AUTH_PREVIEW_PROOF_HEADER, BOOKER_REAL_AUTH_PREVIEW_PROOF_VERSION);
    }
    next();
  });
  router.use(createChatGptBookerMcpRouterCore({ configuration, verification,
    execute: async () => { executorDenials++; throw new Error('BOOKER_PREVIEW_EXECUTION_DISABLED'); },
    providerAdmission: (_req, res) => { providerBoundaryDenials++; res.status(503).json({ error: 'BOOKER_UNAVAILABLE' }); },
    resolveClientIdentity: req => req.ip ?? 'auth0-discovery-preview',
    hasUnsafeBlockingConditions: () => { providerBoundaryDenials++; return true; },
    runWithProviderAdmission: () => { throw new Error('BOOKER_PREVIEW_EXECUTION_DISABLED'); },
  }));
  const evidence = () => ({ version: BOOKER_REAL_AUTH_PREVIEW_PROOF_VERSION, transport: 'actual-production-core',
    authentication: 'auth0-remote-jwks', execution: 'denied', executorDenials, providerBoundaryDenials,
    providerRequests: 0, notionRequests: 0, databaseRequests: 0, jobOperations: 0, canonWrites: 0 });
  router.get(BOOKER_REAL_AUTH_PREVIEW_EVIDENCE_PATH, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache');
    const count = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
    if (count !== 1 || !(await verify(req.header('authorization'))).ok) {
      res.setHeader('WWW-Authenticate', bookerAuthChallenge(configuration));
      res.status(401).json({ error: 'BOOKER_AUTHORIZATION_REQUIRED' }); return;
    }
    res.json(evidence());
  });
  return { router, evidence };
}
