import {
    MemoryRetrieveRequest,
    MemoryWriteRequest
} from "@arcanos/contracts"

export class MemoryService {
    /**
     * Persists a memory event for a user/session pair.
     * Input: MemoryWriteRequest from shared contracts.
     * Output: resolves when write is completed.
     * Edge case: metadata can be omitted.
     */
    async write(input: MemoryWriteRequest): Promise<void> {
        // TODO: embed via AIClient
        // TODO: persist via repository
        void input
    }

    /**
     * Retrieves top-K similar memories for a user/session query.
     * Input: MemoryRetrieveRequest from shared contracts.
     * Output: list of matching memory records.
     * Edge case: returns empty array when no matches are found.
     */
    async retrieve(input: MemoryRetrieveRequest): Promise<unknown[]> {
        // TODO: vector similarity search
        void input
        return []
    }

    /**
     * Runs optional summarization/digest logic for a session.
     * Input: sessionId string.
     * Output: resolves when digest flow completes.
     * Edge case: no-op if there is no digestable data.
     */
    async digest(sessionId: string): Promise<void> {
        // optional summarization logic
        void sessionId
    }
}
