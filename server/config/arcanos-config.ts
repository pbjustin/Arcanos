export class ArcanosConfig {
  public name = "ArcanosConfig";
  public status: "active" | "inactive" | "error" = "active";
  private config = {
    theme: "dark",
    language: "en",
    modules: ["rag", "hrc"],
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "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",
      model: process.env.OPENAI_MODEL || "ft:gpt-3.5-turbo-0125:personal:arc-v1-1106:BpYtP0ox",
      maxTokens: 1000,
      temperature: 0.7
    }
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

  getOpenAIConfig() {
    return this.config.openai;
  }

  updateConfig(config: any, reason: string) {
    this.config = { ...this.config, ...config };
    return { success: true, updated: true, reason };
  }
}