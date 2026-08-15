import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { getRequestAuthenticatedActorKey } from '@platform/runtime/security.js';
import {
  resolveBackstageMutationHttpOperation,
  type BackstageMutationHttpOperation
} from '@services/controlPlane/backstageMutationHttpBoundary.js';
import {
  BackstageBookerContractError,
  normalizeBackstageBookerActionPayload,
  normalizeBackstageBookerIngressMutationPayload,
  type BackstageBookerMutationIngress
} from '@services/backstageBookerContracts.js';
import { isBackstageRosterValidationError } from '@shared/backstage/backstageRoster.js';
import {
  isBackstageStorylineValidationError
} from '@shared/backstage/backstageStoryline.js';
import {
  buildBackstageMutationConfirmationFingerprintBody
} from '@shared/backstage/backstageActionPolicy.js';
import { confirmGate } from './confirmGate.js';

const BACKSTAGE_MUTATION_CONFIRMATION_WORKSPACE_ID =
  'backstage-mutation:control-plane';
const backstageMutationConfirmationApplied = Symbol('backstageMutationConfirmationApplied');

type BackstageMutationConfirmationRequest = Request & {
  [backstageMutationConfirmationApplied]?: true;
};

function normalizeMutationPayload(
  body: unknown,
  operation: BackstageMutationHttpOperation
): unknown | null {
  const ingress: BackstageBookerMutationIngress =
    operation.ingress === 'legacy-module' || operation.ingress === 'legacy-queryroute'
      ? 'legacy'
      : operation.ingress;

  if (operation.action === 'saveStoryline' && ingress === 'direct') {
    const requestRecord = body !== null && typeof body === 'object'
      ? body as Record<string, unknown>
      : {};
    const bookingPayload = { ...requestRecord };
    delete bookingPayload.key;
    const bookingInput = normalizeBackstageBookerActionPayload(
      'generateBooking',
      bookingPayload
    );
    normalizeBackstageBookerActionPayload('saveStoryline', {
      universeId: bookingInput.universeId ?? 'legacy',
      key: Object.prototype.hasOwnProperty.call(requestRecord, 'key')
        ? requestRecord.key
        : 'pending-confirmation-key-validation',
      storyline: 'pending-generation-validation'
    });
    // Preserve the established /book-gpt request-body fingerprint after validating both effects.
    return null;
  }

  switch (operation.action) {
    case 'bookEvent':
    case 'saveStoryline':
    case 'trackStoryline':
    case 'updateRoster':
    case 'upsertStoryline':
    case 'appendCanonBeat':
      return normalizeBackstageBookerIngressMutationPayload(
        operation.action,
        body,
        ingress
      );
    default:
      return null;
  }
}

/** Require the existing confirmation contract only for admitted Backstage mutations. */
export function createBackstageMutationConfirmationGate(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const confirmationRequest = req as BackstageMutationConfirmationRequest;
    if (confirmationRequest[backstageMutationConfirmationApplied]) {
      next();
      return;
    }

    void resolveBackstageMutationHttpOperation(req)
      .then((operation) => {
        if (!operation) {
          next();
          return;
        }

        const principalId = req.controlPlanePrincipal?.principalId;
        if (!principalId) {
          req.logger?.warn?.('backstage_mutation.confirmation_identity_unavailable', {
            action: operation.action,
            ingress: operation.ingress,
            method: req.method,
          });
          res.setHeader('Cache-Control', 'no-store');
          res.status(403).json({
            ok: false,
            error: {
              code: 'CONTROL_PLANE_FORBIDDEN',
              message: 'Control-plane operation is not permitted.',
            },
          });
          return;
        }

        let confirmationPayload: unknown | null;
        try {
          confirmationPayload = normalizeMutationPayload(req.body, operation);
        } catch (error: unknown) {
          if (
            !(error instanceof BackstageBookerContractError)
            && !isBackstageRosterValidationError(error)
            && !isBackstageStorylineValidationError(error)
          ) {
            throw error;
          }

          // Let the ingress-specific handler render its established validation shape,
          // but never issue a confirmation challenge for an invalid mutation.
          next();
          return;
        }

        confirmationRequest[backstageMutationConfirmationApplied] = true;
        confirmGate(req, res, next, {
          challengeBinding: {
            actorKey: getRequestAuthenticatedActorKey(req),
            principalId,
            workspaceId: BACKSTAGE_MUTATION_CONFIRMATION_WORKSPACE_ID,
          },
          requestFingerprintBody: buildBackstageMutationConfirmationFingerprintBody(
            operation.action,
            confirmationPayload ?? req.body
          ),
        });
      })
      .catch(next);
  };
}

export const backstageMutationConfirmationGate =
  createBackstageMutationConfirmationGate();
