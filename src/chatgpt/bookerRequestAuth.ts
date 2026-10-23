import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';
import { createGptClientRegistry, type AuthenticatedGptClientIdentity } from '@shared/gpt/gptClientRegistry.js';
import { isBookerMcpInput } from '@shared/chatgpt/bookerMcpContract.js';
import type { ChatGptPrincipal } from './auth.js';
import { hasBookerPermission } from './bookerAuth.js';

export type BookerGptAction = 'queryContinuity' | 'generateBooking' | 'generateBookingWithHRC' | 'simulateMatch';
interface BookerMcpRequestAuthentication {
  principal: ChatGptPrincipal;
  universeId: string;
  action: BookerGptAction;
  body: Record<string, unknown>;
  identity: AuthenticatedGptClientIdentity;
  providerAdmitted: boolean;
}
const authenticatedRequests = new WeakMap<Request, BookerMcpRequestAuthentication>();
const admittedProviderRequest = new AsyncLocalStorage<true>();
const actions = new Set<BookerGptAction>(['queryContinuity', 'generateBooking', 'generateBookingWithHRC', 'simulateMatch']);

/** Internal requests are constructed by the fixed adapter, never deserialized from an HTTP caller. */
export function establishBookerMcpRequestAuthentication(req: Request, principal: ChatGptPrincipal): void {
  const body = req.body as Record<string, unknown>;
  const action = body?.action as BookerGptAction;
  const payload = body?.payload as Record<string, unknown>;
  if (req.method !== 'POST' || req.url !== '/gpt/backstage-booker' || !actions.has(action)
    || !isBookerMcpInput(action, payload) || typeof payload.universeId !== 'string'
    || !hasBookerPermission(principal, action !== 'queryContinuity', payload.universeId) || !principal.oauthClientId) {
    throw new Error('BOOKER_PERMISSION_DENIED');
  }
  const registry = createGptClientRegistry([{
    clientId: 'backstage-booker-plugin', gptId: 'backstage-booker', displayName: 'Backstage Booker Plugin',
    registeredModelProfile: null, authenticationType: 'oauth', oauthClientId: principal.oauthClientId, status: 'active',
  }]);
  const identity = registry.resolveAuthenticatedClient({ clientId: 'backstage-booker-plugin',
    authentication: { authenticationType: 'oauth', authenticatedUser: {
      subject: principal.subject, oauthClientId: principal.oauthClientId, scopes: principal.scopes,
    } } });
  if (!identity) throw new Error('BOOKER_CLIENT_UNAVAILABLE');
  authenticatedRequests.set(req, { principal, universeId: payload.universeId, action, body, identity,
    providerAdmitted: admittedProviderRequest.getStore() === true });
}

export function clearBookerMcpRequestAuthentication(req: Request): void { authenticatedRequests.delete(req); }

function requestAuthentication(req: Request): BookerMcpRequestAuthentication | null {
  const authentication = authenticatedRequests.get(req);
  if (!authentication || req.method !== 'POST' || req.originalUrl !== '/gpt/backstage-booker'
    || req.body !== authentication.body || req.body.action !== authentication.action
    || req.body.payload?.universeId !== authentication.universeId) return null;
  return authentication;
}

/**
 * In-flight lane identity, established after OAuth authorization. Expiry must
 * never downgrade an already protected request to the public compatibility lane.
 * New requests still revalidate OAuth; the outer operation owns its deadline.
 */
export function hasBookerMcpGenerationAuthentication(req: Request): boolean { return requestAuthentication(req) !== null; }
export function getBookerMcpGptClientIdentity(req: Request): AuthenticatedGptClientIdentity | null { return requestAuthentication(req)?.identity ?? null; }

/** Called only around an OAuth tool call already admitted on its incoming HTTP request. */
export function runWithBookerMcpProviderAdmission<T>(operation: () => T): T { return admittedProviderRequest.run(true, operation); }
export function hasBookerMcpProviderAdmission(req?: Request): boolean {
  return req ? requestAuthentication(req)?.providerAdmitted === true : admittedProviderRequest.getStore() === true;
}
