import crypto from 'node:crypto';

import { getEnv } from '@platform/runtime/env.js';

import type { ControlPlaneApprovalStatus, ControlPlaneRequest } from './types.js';

export interface ControlPlaneApprovalDecision {
  ok: boolean;
  status: ControlPlaneApprovalStatus;
  reason?: string;
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function readControlPlaneApprovalToken(): string | undefined {
  return getEnv('ARCANOS_CONTROL_PLANE_APPROVAL_TOKEN');
}

export function evaluateControlPlaneApproval(
  request: ControlPlaneRequest,
  approvalRequired: boolean,
  tokenReader: () => string | undefined = readControlPlaneApprovalToken
): ControlPlaneApprovalDecision {
  if (!approvalRequired) {
    return { ok: true, status: 'not_required' };
  }

  const configuredToken = tokenReader()?.trim();
  if (!configuredToken) {
    return {
      ok: false,
      status: 'unconfigured',
      reason: 'Control-plane approval token is not configured for gated operations.',
    };
  }

  const suppliedToken = request.approvalToken?.trim();
  if (!suppliedToken) {
    return {
      ok: false,
      status: 'missing',
      reason: 'Approval token is required for this control-plane operation.',
    };
  }

  if (!timingSafeEqualString(suppliedToken, configuredToken)) {
    return {
      ok: false,
      status: 'invalid',
      reason: 'Approval token is invalid.',
    };
  }

  return { ok: true, status: 'approved' };
}
