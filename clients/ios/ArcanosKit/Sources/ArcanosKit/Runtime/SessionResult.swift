import Foundation

public struct SessionResult: Sendable {
    public enum Kind: String, Sendable { case answer, pending, confirmationRequired, failure, cancelled, unavailable, clarificationRequired }
    public let text: String
    public let kind: Kind
    public let approvalID: UUID?
    public let jobID: String?
    public let operationID: UUID?
    public let partition: OperationPartition?

    public init(text: String, kind: Kind, approvalID: UUID? = nil, jobID: String? = nil,
                operationID: UUID? = nil, partition: OperationPartition? = nil) {
        self.text = text
        self.kind = kind
        self.approvalID = approvalID
        self.jobID = jobID
        self.operationID = operationID
        self.partition = partition
    }

    public static func failure(_ error: any Error) -> SessionResult {
        if let failure = error as? RecoverySubmissionFailure { return failure.result }
        let text: String
        var kind: Kind = error is CancellationError ? .cancelled : .failure
        switch error {
        case is CancellationError:
            text = "ARCANOS stopped waiting. Any backend action already accepted may still run; no automatic retry will be sent."
        case GatewayError.unpaired, AIError.remoteNotPaired:
            text = "Remote ARCANOS needs device pairing. Complete pairing in the app. Any previously saved operation remains unverified."
        case GatewayError.credentialExpired:
            text = "Your ARCANOS device session expired. Pair again before using remote actions."
        case GatewayError.unavailable:
            text = "The ARCANOS gateway is unavailable. Completion is unknown; the request will not be retried automatically."
            kind = .unavailable
        case CredentialStoreError.lockedOrUnavailable, CredentialStoreError.unsupportedPlatform:
            text = "Secure credentials are currently unavailable. Unlock the device and try again. Your saved identity and operations have been preserved."
            kind = .unavailable
        case OperationTrackingError.storageUnavailable:
            text = "The saved ARCANOS operations are currently unavailable. Completion is unverified; no automatic replay will be sent. Try checking again when device storage is available."
            kind = .unavailable
        case OperationTrackingError.corruptStore:
            text = "ARCANOS could not verify the saved recovery index. It has been preserved. Completion is unverified; no automatic replay will be sent."
            kind = .unavailable
        case OperationTrackingError.ambiguousReference:
            text = "More than one recent ARCANOS operation matches. Specify the operation ID to check."
            kind = .clarificationRequired
        case OperationTrackingError.notFound:
            text = "There is no matching recent operation for this paired device and Gateway. Specify a saved operation ID or start a new request."
            kind = .unavailable
        case ConfirmationError.notPending:
            text = "There is no matching pending approval. Ask ARCANOS to prepare the action again."
        case ConfirmationError.expired:
            text = "That approval expired. Ask ARCANOS to prepare the action again."
        case ConfirmationError.repeatedChallenge:
            text = "The gateway did not accept the one-time approval. ARCANOS stopped without another retry."
        case ConfirmationError.busy:
            text = "An action is already awaiting approval or a response. Finish or cancel it first."
        case AIError.invalidInput:
            text = "Provide a nonempty request or note within the local size limit."
        case AIError.jobFailed:
            text = "The backend reported that the job did not complete successfully."
        case let gatewayError as GatewayError:
            text = gatewayError.userFacingMessage
        default:
            // Do not interpolate errors: transport/server text may contain credentials or raw payloads.
            text = "ARCANOS could not verify the result. No success is being reported."
        }
        return SessionResult(text: text, kind: kind)
    }
}
