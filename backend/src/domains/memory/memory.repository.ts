export class MemoryRepository {
    async save(record: any) {
        // Prisma write
    }

    async findSimilar(vector: number[], topK: number) {
        // vector DB lookup
        return []
    }
}
