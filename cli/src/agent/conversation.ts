const HISTORY_CONTEXT_LENGTH = 10

export interface ConversationTurn {
    role: "user" | "assistant"
    content: string
}

export class Conversation {
    private history: ConversationTurn[] = []

    /**
     * Adds a single conversation turn to in-memory history.
     * Input: ConversationTurn with explicit role/content.
     * Output: none.
     * Edge case: accepts repeated roles and duplicate content without deduplication.
     */
    addTurn(turn: ConversationTurn): void {
        this.history.push(turn)
    }

    /**
     * Returns the most recent context window for prompt construction.
     * Input: none.
     * Output: latest N turns using HISTORY_CONTEXT_LENGTH.
     * Edge case: returns full history when fewer than N turns exist.
     */
    getContext(): ConversationTurn[] {
        return this.history.slice(-HISTORY_CONTEXT_LENGTH)
    }
}
