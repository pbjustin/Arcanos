export class ArcanosConfig {
  public name = "ArcanosConfig";
  public status: "active" | "inactive" | "error" = "active";
  private config = {
    theme: "dark",
    language: "en",
    modules: ["rag", "hrc"],
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
      fineTuneModel: process.env.OPENAI_FINE_TUNE_MODEL || "",
      defaultModel: "gpt-3.5-turbo"
    }
  };

  async initialize() {
    // Load config from file or DB if preferred
    if (!this.config.openai.apiKey) {
      console.error('[ArcanosConfig] OpenAI API key not found in environment variables');
      this.status = "error";
      throw new Error('OpenAI API key is required');
    }
    if (!this.config.openai.fineTuneModel) {
      console.error('[ArcanosConfig] OpenAI fine-tune model not found in environment variables');
      this.status = "error";
      throw new Error('OpenAI fine-tune model is required');
    }
    this.status = "active";
    console.log('[ArcanosConfig] OpenAI configuration loaded successfully');
    console.log(`[ArcanosConfig] Using fine-tune model: ${this.config.openai.fineTuneModel}`);
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