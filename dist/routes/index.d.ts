import type { Application } from 'express';
import type { MemoryStorage } from '../storage/memory-storage';
import type { ArcanosRAG } from '../modules/rag';
import type { HRCCore } from '../modules/hrc';
import type { ArcanosConfig } from '../config/arcanos-config';
interface ServerComponents {
    memoryStorage: MemoryStorage;
    arcanosConfig: ArcanosConfig;
    ragModule: ArcanosRAG;
    hrcCore: HRCCore;
}
export declare function registerRoutes(app: Application, components: ServerComponents): void;
export {};
//# sourceMappingURL=index.d.ts.map