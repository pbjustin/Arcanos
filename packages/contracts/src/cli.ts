export interface EscalationRequest {
  userId: string
  sessionId: string
  query: string
  context?: string[]
}

export interface EscalationResponse {
  output: string
  memoryWrites?: {
    content: string
    metadata?: Record<string, any>
  }[]
}
