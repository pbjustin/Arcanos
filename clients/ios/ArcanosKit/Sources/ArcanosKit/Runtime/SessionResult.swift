import Foundation

public struct SessionResult: Sendable {
    public enum Kind: String, Sendable { case answer, pending, confirmationRequired, failure, cancelled }
    public let text: String
    public let kind: Kind
    public let approvalID: UUID?
    public let jobID: String?

    public init(text: String, kind: Kind, approvalID: UUID? = nil, jobID: String? = nil) {
        self.text = text
        self.kind = kind
        self.approvalID = approvalID
        self.jobID = jobID
    }

    public static func failure(_ error: any Error) -> SessionResult {
        let text: String
        switch error {
        case is CancellationError:
            text = "ARCANOS stopped waiting. Any backend action already accepted may still run; no automatic retry will be sent."
        case GatewayError.unpaired, AIError.remoteNotPaired:
            text = "This request needs remote ARCANOS. Device pairing is not available yet. No action was sent."
        case GatewayError.credentialExpired:
            text = "Your ARCANOS device session expired. Pair again before using remote actions."
        case GatewayError.unavailable:
            text = "The ARCANOS gateway is unavailable. Completion is unknown; the request will not be retried automatically."
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
        return SessionResult(text: text, kind: error is CancellationError ? .cancelled : .failure)
    }
}
