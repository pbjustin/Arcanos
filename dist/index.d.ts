import { MemoryStorage } from "./storage/memory-storage";
import { ArcanosRAG } from "./modules/rag";
import { HRCCore } from "./modules/hrc";
import { ArcanosConfig } from "./config/arcanos-config";
declare const app: import("express-serve-static-core").Express;
declare const server: import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>;
declare const memoryStorage: MemoryStorage;
declare const arcanosConfig: ArcanosConfig;
declare const ragModule: ArcanosRAG;
declare const hrcCore: HRCCore;
export { app, server, memoryStorage, arcanosConfig, ragModule, hrcCore };
//# sourceMappingURL=index.d.ts.map