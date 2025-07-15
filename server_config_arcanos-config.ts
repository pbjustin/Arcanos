export class ArcanosConfig {
  public name = "ArcanosConfig";
  public status: "active" | "inactive" | "error" = "active";
  private config = {
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

  updateConfig(config: any, reason: string) {
    this.config = { ...this.config, ...config };
    return { success: true, updated: true, reason };
  }
}