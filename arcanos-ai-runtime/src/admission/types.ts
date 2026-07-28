export type RuntimeRateDecision =
  | { kind: "allowed" }
  | { kind: "rate_limited"; retryAfterMs: number };

export type RuntimeReservationDecision =
  | { kind: "granted" }
  | { kind: "saturated"; retryAfterMs: number };

export type RuntimeConfirmationDecision =
  | "confirmed"
  | "already_confirmed"
  | "already_released"
  | "wrong_owner";

export type RuntimeExecutionClaim =
  | "claimed"
  | "already_claimed"
  | "missing"
  | "wrong_owner";

export interface RuntimeReconciliationCandidate {
  jobId: string;
  state: "pending" | "live";
}

export type RuntimeMissingObservation =
  | "first_observation"
  | "awaiting_confirmation"
  | "released"
  | "already_released"
  | "wrong_owner";

export interface RuntimeAdmissionPort {
  consumeEnqueueRate(
    principalId: string
  ): Promise<RuntimeRateDecision>;
  reserve(input: {
    jobId: string;
    principalId: string;
  }): Promise<RuntimeReservationDecision>;
  confirmQueued(
    jobId: string,
    principalId: string
  ): Promise<RuntimeConfirmationDecision>;
  claimForExecution(
    jobId: string,
    principalId: string,
    claimId: string
  ): Promise<RuntimeExecutionClaim>;
  releaseTerminal(
    jobId: string,
    principalId: string,
    claimId: string
  ): Promise<void>;
}

export interface RuntimeAdmissionReconciliationPort
  extends RuntimeAdmissionPort {
  listReconciliationCandidates(input: {
    pendingGraceMs: number;
    liveGraceMs: number;
    batchSize: number;
  }): Promise<RuntimeReconciliationCandidate[]>;
  observeMissing(
    jobId: string,
    principalId: string,
    confirmationMs: number
  ): Promise<RuntimeMissingObservation>;
  releaseReconciled(
    jobId: string,
    principalId: string
  ): Promise<void>;
}
