import { EscalationRequest } from "@arcanos/contracts"
import { backendClient } from "../transport/backendClient"

/**
 * Sends an escalation request to the backend gateway.
 * Input: EscalationRequest from shared contracts.
 * Output: backend escalation response payload.
 * Edge case: throws if backend rejects request or returns non-2xx status.
 */
export async function escalate(input: EscalationRequest): Promise<unknown> {
    return backendClient.post("/cli/escalate", input, {
        authenticatedUserId: input.userId
    })
}
