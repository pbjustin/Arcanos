export declare class ArcanosConfig {
    name: string;
    status: "active" | "inactive" | "error";
    private config;
    initialize(): Promise<void>;
    getConfig(): {
        theme: string;
        language: string;
        modules: string[];
    };
    getEnabledModules(): string[];
    updateConfig(config: any, reason: string): {
        success: boolean;
        updated: boolean;
        reason: string;
    };
}
//# sourceMappingURL=arcanos-config.d.ts.map