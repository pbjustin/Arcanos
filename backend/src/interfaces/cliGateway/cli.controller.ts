import {
    EscalationRequest,
    MemoryRetrieveRequest,
    MemoryWriteRequest
} from "@arcanos/contracts"
import { Orchestrator } from "../../core/orchestration/orchestrator"

interface AuthenticatedIdentity {
    userId: string
}

interface AuthenticatedRequest<TRequestBody> {
    body: TRequestBody
    auth?: AuthenticatedIdentity
    user?: { id: string }
}

type AuthorizationErrorCode = "UNAUTHORIZED" | "FORBIDDEN"

class GatewayAuthorizationError extends Error {
    constructor(
        public readonly code: AuthorizationErrorCode,
        message: string
    ) {
        super(message)
        this.name = "GatewayAuthorizationError"
    }
}

export class CLIGatewayController {
    constructor(private readonly orchestrator: Orchestrator) { }

    /**
     * Handles CLI escalation requests.
     * Input: authenticated request with EscalationRequest body.
     * Output: orchestrator escalation result.
     * Edge case: throws structured UNAUTHORIZED/FORBIDDEN errors when identity checks fail.
     */
    async escalate(req: AuthenticatedRequest<EscalationRequest>): Promise<unknown> {
        const trustedEscalationRequest = this.assertAuthorizedUser(req)
        return this.orchestrator.handleEscalation(trustedEscalationRequest)
    }

    /**
     * Handles memory retrieval requests from the CLI gateway.
     * Input: authenticated request with MemoryRetrieveRequest body.
     * Output: memory retrieval response from downstream service.
     * Edge case: not implemented yet in this scaffold.
     */
    async retrieveMemory(req: AuthenticatedRequest<MemoryRetrieveRequest>): Promise<void> {
        // call memory service
        void req
    }

    /**
     * Handles memory write requests from the CLI gateway.
     * Input: authenticated request with MemoryWriteRequest body.
     * Output: write acknowledgement from downstream service.
     * Edge case: not implemented yet in this scaffold.
     */
    async writeMemory(req: AuthenticatedRequest<MemoryWriteRequest>): Promise<void> {
        // call memory service
        void req
    }

    /**
     * Validates authenticated identity ownership against request payload userId.
     * Input: request containing auth context and body.userId.
     * Output: trusted body with canonical authenticated userId.
     * Edge case: throws structured authorization errors when identity is missing or mismatched.
     */
    private assertAuthorizedUser(
        req: AuthenticatedRequest<EscalationRequest>
    ): EscalationRequest {
        const authenticatedUserId = req.auth?.userId ?? req.user?.id

        //audit Assumption: upstream middleware populates req.auth.userId or req.user.id for authenticated requests.
        //audit Failure risk: missing identity allows unauthenticated escalation attempts (IDOR entry point).
        //audit Expected invariant: escalation requests always include an authenticated identity.
        //audit Handling strategy: fail fast with an explicit UNAUTHORIZED error.
        if (!authenticatedUserId) {
            throw new GatewayAuthorizationError(
                "UNAUTHORIZED",
                "Authenticated identity is required for escalation"
            )
        }

        //audit Assumption: authenticated identity is the single source of truth for request ownership.
        //audit Failure risk: mismatched userId enables cross-user data access and manipulation.
        //audit Expected invariant: req.body.userId must exactly match authenticated identity.
        //audit Handling strategy: reject mismatch with explicit FORBIDDEN error before orchestration.
        if (req.body.userId !== authenticatedUserId) {
            throw new GatewayAuthorizationError(
                "FORBIDDEN",
                "Escalation userId must match authenticated identity"
            )
        }

        //audit Assumption: downstream services should only receive canonicalized ownership data.
        //audit Failure risk: relying on raw payload userId can allow subtle tampering paths.
        //audit Expected invariant: returned request always contains authenticated userId.
        //audit Handling strategy: overwrite userId with the authenticated identity.
        return {
            ...req.body,
            userId: authenticatedUserId
        }
    }
}
