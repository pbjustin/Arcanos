import type { QueryContext, RAGResponse } from '../types';
export declare class ArcanosRAG {
    name: string;
    status: "active" | "inactive" | "error";
    private docs;
    initialize(): Promise<void>;
    query(context: QueryContext): Promise<{
        success: boolean;
        data: RAGResponse;
    }>;
    addDocument(content: string, metadata: any): Promise<{
        success: boolean;
    }>;
}
//# sourceMappingURL=rag.d.ts.map