import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { getRequestAuthenticatedActorKey } from '@platform/runtime/security.js';
import { resolveBackstageMutationHttpOperation } from '@services/controlPlane/backstageMutationHttpBoundary.js';
import { confirmGate } from './confirmGate.js';

const BACKSTAGE_MUTATION_CONFIRMATION_WORKSPACE_ID =
  'backstage-mutation:control-plane';
const backstageMutationConfirmationApplied = Symbol('backstageMutationConfirmationApplied');

type BackstageMutationConfirmationRequest = Request & {
  [backstageMutationConfirmationApplied]?: true;
};

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

        confirmationRequest[backstageMutationConfirmationApplied] = true;
        confirmGate(req, res, next, {
          challengeBinding: {
            actorKey: getRequestAuthenticatedActorKey(req),
            principalId,
            workspaceId: BACKSTAGE_MUTATION_CONFIRMATION_WORKSPACE_ID,
          },
          requestFingerprintBody: {
            protocol: 'backstage-mutation-confirmation-v1',
            action: operation.action,
            body: req.body,
          },
        });
      })
      .catch(next);
  };
}

export const backstageMutationConfirmationGate =
  createBackstageMutationConfirmationGate();
