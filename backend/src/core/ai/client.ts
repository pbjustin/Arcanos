export interface AIRequest {
    model: string
    messages: any[]
    temperature?: number
    metadata?: Record<string, any>
}

export interface AIResponse {
    content: string
    usage?: {
        promptTokens: number
        completionTokens: number
    }
}

export class AIClient {
    async execute(req: AIRequest): Promise<AIResponse> {
        // TODO: add logging
        // TODO: add retry
        // TODO: add circuit breaker
        // TODO: add telemetry
        throw new Error("Not implemented")
    }
}
