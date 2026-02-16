export interface MemoryWriteInput {
    userId: string
    sessionId: string
    content: string
    metadata?: Record<string, any>
}

export interface MemoryRetrieveInput {
    userId: string
    sessionId: string
    query: string
    topK: number
}

export class MemoryService {
    async write(input: MemoryWriteInput) {
        // TODO: embed via AIClient
        // TODO: persist via repository
    }

    async retrieve(input: MemoryRetrieveInput) {
        // TODO: vector similarity search
        return []
    }

    async digest(sessionId: string) {
        // optional summarization logic
    }
}
