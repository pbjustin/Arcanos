export class ArcanosConfig {
    name = "ArcanosConfig";
    status = "active";
    config = {
        theme: "dark",
        language: "en",
        modules: ["rag", "hrc"]
    };
    async initialize() {
        // Load config from file or DB if preferred
        this.status = "active";
    }
    getConfig() {
        return this.config;
    }
    getEnabledModules() {
        return this.config.modules;
    }
    updateConfig(config, reason) {
        this.config = { ...this.config, ...config };
        return { success: true, updated: true, reason };
    }
}
//# sourceMappingURL=arcanos-config.js.map