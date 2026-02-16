export class Orchestrator {
    constructor(
        private readonly reasoningEngine: any,
        private readonly memoryDomain: any
    ) { }

    async handleEscalation(input: {
        userId: string
        sessionId: string
        query: string
    }) {
        const memories = await this.memoryDomain.retrieve({
            userId: input.userId,
            sessionId: input.sessionId,
            query: input.query,
            topK: 5
        })

        return this.reasoningEngine.run({
            query: input.query,
            context: memories
        })
    }
}
