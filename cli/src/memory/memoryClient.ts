import { backendClient } from "../transport/backendClient"

export async function retrieveMemory(payload: any) {
    return backendClient.post("/cli/memory/retrieve", payload)
}

export async function writeMemory(payload: any) {
    return backendClient.post("/cli/memory/write", payload)
}
