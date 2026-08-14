import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { BackstageBookerActionInputMap } from '@arcanos/protocol';
import { BackstageBooker } from '@services/backstage-booker.js';
import {
  BackstageBookerContractError,
  normalizeBackstageBookerActionPayload,
  normalizeBackstageBookerIngressMutationPayload
} from '@services/backstageBookerContracts.js';
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import { backstageMutationConfirmationGate } from '@transport/http/middleware/backstageMutationConfirmationGate.js';
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { sendBadRequestPayload, sendInternalErrorPayload } from '@shared/http/index.js';
import { backstageMutationHttpBoundary } from '@services/controlPlane/backstageMutationHttpBoundary.js';
import {
  isBackstageRosterPersistenceError,
  isBackstageRosterValidationError
} from '@shared/backstage/backstageRoster.js';
import {
  isBackstageStorylinePersistenceError,
  isBackstageStorylineValidationError
} from '@shared/backstage/backstageStoryline.js';

const router = express.Router();

function sendBackstageRouteError(res: Response, error: unknown): void {
  if (error instanceof BackstageBookerContractError) {
    res.status(400).json({
      success: false,
      error: error.message,
      action: error.action,
      issues: error.issues
    });
    return;
  }

  if (isBackstageRosterValidationError(error) || isBackstageStorylineValidationError(error)) {
    sendBadRequestPayload(res, {
      success: false,
      error: {
        code: error.code,
        message: error.message
      }
    });
    return;
  }

  if (
    isBackstageRosterPersistenceError(error)
    || isBackstageStorylinePersistenceError(error)
  ) {
    res.status(503).json({
      success: false,
      error: {
        code: error.code,
        message: error.message
      }
    });
    return;
  }

  sendInternalErrorPayload(res, { success: false, error: resolveErrorMessage(error) });
}

function normalizeDirectOpenPayload(
  action: 'bookEvent',
  body: unknown
): BackstageBookerActionInputMap['bookEvent'];
function normalizeDirectOpenPayload(
  action: 'trackStoryline',
  body: unknown
): BackstageBookerActionInputMap['trackStoryline'];
function normalizeDirectOpenPayload(
  action: 'bookEvent' | 'trackStoryline',
  body: unknown
): BackstageBookerActionInputMap['bookEvent'] | BackstageBookerActionInputMap['trackStoryline'] {
  if (action === 'trackStoryline') {
    return normalizeBackstageBookerIngressMutationPayload(action, body, 'direct');
  }

  const record = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  if (!record) {
    return normalizeBackstageBookerActionPayload(action, body);
  }

  const wrapperKey = action === 'bookEvent' ? 'event' : 'beat';
  const wrappedValue = record[wrapperKey];
  const isCanonicalWrapper = Object.prototype.hasOwnProperty.call(record, 'universeId')
    && wrappedValue !== null
    && typeof wrappedValue === 'object'
    && !Array.isArray(wrappedValue)
    && Object.keys(record).every(key => key === 'universeId' || key === wrapperKey);
  if (isCanonicalWrapper) {
    return normalizeBackstageBookerActionPayload(action, record);
  }

  const domainPayload = { ...record };
  delete domainPayload.universeId;
  return normalizeBackstageBookerActionPayload(action, {
    universeId: Object.prototype.hasOwnProperty.call(record, 'universeId')
      ? record.universeId
      : 'legacy',
    [wrapperKey]: domainPayload
  });
}

// Entry point for Backstage Booker
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'success',
    module: 'Backstage Booker',
    role: 'entrypoint',
    timestamp: Date.now()
  });
});

// Book Event
router.post('/book-event', backstageMutationHttpBoundary, backstageMutationConfirmationGate, async (req: Request, res: Response) => {
  try {
    const input = normalizeDirectOpenPayload('bookEvent', req.body);
    const result = await BackstageBooker.bookEvent(
      input.event,
      input.universeId ?? 'legacy'
    );
    res.status(200).json({ success: true, ...result, eventID: result.eventId });
  } catch (error: unknown) {
    sendBackstageRouteError(res, error);
  }
});

// Generate and save storyline via custom GPT
router.post('/book-gpt', backstageMutationHttpBoundary, backstageMutationConfirmationGate, async (req: Request, res: Response) => {
  try {
    const requestRecord = req.body !== null && typeof req.body === 'object'
      ? req.body as Record<string, unknown>
      : {};
    const bookingPayload = { ...requestRecord };
    delete bookingPayload.key;
    const input = normalizeBackstageBookerActionPayload('generateBooking', bookingPayload);
    const universeId = input.universeId ?? 'legacy';
    const requestedKey = Object.prototype.hasOwnProperty.call(requestRecord, 'key')
      ? requestRecord.key
      : randomUUID();
    const prevalidatedSaveInput = normalizeBackstageBookerActionPayload('saveStoryline', {
      universeId,
      key: requestedKey,
      storyline: 'pending-generation-validation'
    });
    const storyline = await BackstageBooker.generateBooking(input.prompt, universeId);
    const savedStoryline = await BackstageBooker.saveStoryline(
      prevalidatedSaveInput.key,
      storyline,
      prevalidatedSaveInput.universeId ?? 'legacy'
    );
    res.status(200).json({ success: true, storyline, ...savedStoryline });
  } catch (error: unknown) {
    sendBackstageRouteError(res, error);
  }
});

// Simulate Match
router.post('/simulate-match', confirmGate, async (req: Request, res: Response) => {
  try {
    const input = normalizeBackstageBookerActionPayload('simulateMatch', req.body);
    const simulation = await BackstageBooker.simulateMatch(
      input.match,
      input.rosters,
      input.winProbModifier ?? 0,
      input.universeId ?? 'legacy'
    );
    res.status(200).json({
      success: true,
      universeId: simulation.universeId,
      result: { ...simulation.result, hrc: simulation.hrc },
      matchResult: simulation.result,
      hrc: simulation.hrc
    });
  } catch (error: unknown) {
    sendBackstageRouteError(res, error);
  }
});

// Update Roster
router.post('/update-roster', backstageMutationHttpBoundary, backstageMutationConfirmationGate, async (req: Request, res: Response) => {
  try {
    const input = normalizeBackstageBookerIngressMutationPayload(
      'updateRoster',
      req.body,
      'direct'
    );
    const result = await BackstageBooker.updateRoster(
      input.wrestlers,
      input.universeId ?? 'legacy'
    );
    res.status(200).json({ success: true, ...result });
  } catch (error: unknown) {
    sendBackstageRouteError(res, error);
  }
});

// Track Storyline
router.post('/track-storyline', backstageMutationHttpBoundary, backstageMutationConfirmationGate, async (req: Request, res: Response) => {
  try {
    const input = normalizeDirectOpenPayload('trackStoryline', req.body);
    const result = await BackstageBooker.trackStoryline(
      input.beat,
      input.universeId ?? 'legacy'
    );
    res.status(200).json({ success: true, ...result, storyline: result.beats });
  } catch (error: unknown) {
    sendBackstageRouteError(res, error);
  }
});

export default router;
