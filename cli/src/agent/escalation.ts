import { backendClient } from "../transport/backendClient"

export async function escalate(input: {
    userId: string
    sessionId: string
    query: string
}) {
    return backendClient.post("/cli/escalate", input)
}
