export class ArcanosConfig {
  public name = "ArcanosConfig";
  public status: "active" | "inactive" | "error" = "active";
  private config = {
    theme: "dark",
    language: "en",
    modules: ["rag", "hrc"],
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
      fineTuneModel: process.env.OPENAI_FINE_TUNE_MODEL || "gpt-3.5-turbo",
      defaultModel: "gpt-3.5-turbo"
    }
  };

  async initialize() {
    // Load config from file or DB if preferred
    if (!this.config.openai.apiKey) {
      console.warn('[ArcanosConfig] OpenAI API key not found in environment variables');
      this.status = "error";
      return;
    }
    this.status = "active";
    console.log('[ArcanosConfig] OpenAI configuration loaded successfully');
  }

  getConfig() {
    return this.config;
  }

  getOpenAIConfig() {
    return this.config.openai;
  }

  getEnabledModules() {
    return this.config.modules;
  }

  updateConfig(config: any, reason: string) {
    this.config = { ...this.config, ...config };
    return { success: true, updated: true, reason };
  }
}