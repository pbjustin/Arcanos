import { MemoryService } from "../../domains/memory/memory.service"

export async function memoryWorker(job: any) {
    const service = new MemoryService()

    switch (job.type) {
        case "WRITE":
            return service.write(job.payload)

        case "DIGEST":
            return service.digest(job.payload.sessionId)

        default:
            throw new Error("Unknown job type")
    }
}
