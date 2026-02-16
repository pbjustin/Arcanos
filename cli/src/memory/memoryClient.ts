import {
    MemoryRetrieveRequest,
    MemoryWriteRequest
} from "@arcanos/contracts"
import { backendClient } from "../transport/backendClient"

/**
 * Requests similar memory records for a user/session query.
 * Input: MemoryRetrieveRequest from shared contracts.
 * Output: backend retrieval response payload.
 * Edge case: throws if backend rejects request or returns non-2xx status.
 */
export async function retrieveMemory(payload: MemoryRetrieveRequest): Promise<unknown> {
    return backendClient.post("/cli/memory/retrieve", payload)
}

/**
 * Writes a memory record for a user/session pair.
 * Input: MemoryWriteRequest from shared contracts.
 * Output: backend write response payload.
 * Edge case: throws if backend rejects request or returns non-2xx status.
 */
export async function writeMemory(payload: MemoryWriteRequest): Promise<unknown> {
    return backendClient.post("/cli/memory/write", payload)
}
