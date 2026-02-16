import {
    EscalationRequest,
    MemoryRetrieveRequest
} from "@arcanos/contracts"

interface ReasoningEngine {
    run(input: { query: string, context: unknown[] }): Promise<unknown>
}

interface MemoryDomain {
    retrieve(input: MemoryRetrieveRequest): Promise<unknown[]>
}

const DEFAULT_MEMORY_RETRIEVAL_TOP_K = 5

export class Orchestrator {
    constructor(
        private readonly reasoningEngine: ReasoningEngine,
        private readonly memoryDomain: MemoryDomain
    ) { }

    /**
     * Coordinates memory retrieval and reasoning for an escalation request.
     * Input: EscalationRequest from shared contracts.
     * Output: reasoning engine result.
     * Edge case: returns reasoning result with empty context when no memories are found.
     */
    async handleEscalation(input: EscalationRequest): Promise<unknown> {
        const memoryRetrieveRequest: MemoryRetrieveRequest = {
            userId: input.userId,
            sessionId: input.sessionId,
            query: input.query,
            topK: DEFAULT_MEMORY_RETRIEVAL_TOP_K
        }

        //audit Assumption: topK default remains tuned for backend latency budget.
        //audit Failure risk: overly small topK can reduce context quality; overly large topK can increase latency.
        //audit Expected invariant: retrieve request always includes a positive topK value.
        //audit Handling strategy: centralize topK in a named constant for safer future tuning.
        const memories = await this.memoryDomain.retrieve(memoryRetrieveRequest)

        return this.reasoningEngine.run({
            query: input.query,
            context: memories
        })
    }
}
