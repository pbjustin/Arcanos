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
      defaultModel: "gpt-3.5-turbo",
      useFineTuned: process.env.USE_FINE_TUNED === "true"
    }
  };

  async initialize() {
    // Load config from file or DB if preferred
    if (!this.config.openai.apiKey) {
      console.error('[ArcanosConfig] OpenAI API key not found in environment variables');
      this.status = "error";
      throw new Error('OpenAI API key is required');
    }
    
    // Validate fine-tune model if USE_FINE_TUNED is true
    if (this.config.openai.useFineTuned && !this.config.openai.fineTuneModel) {
      console.error('[ArcanosConfig] OpenAI fine-tune model not found in environment variables');
      this.status = "error";
      throw new Error('OpenAI fine-tune model is required when USE_FINE_TUNED is true');
    }
    
    this.status = "active";
    console.log('[ArcanosConfig] OpenAI configuration loaded successfully');
    console.log(`[ArcanosConfig] Using model: ${this.getModel()}`);
    console.log(`[ArcanosConfig] Fine-tuned mode: ${this.config.openai.useFineTuned ? 'enabled' : 'disabled'}`);
  }

  getConfig() {
    return this.config;
  }

  getOpenAIConfig() {
    return this.config.openai;
  }

  /**
   * Returns the model to use based on USE_FINE_TUNED environment variable
   * @returns {string} The model name to use for OpenAI API calls
   */
  getModel(): string {
    return this.config.openai.useFineTuned 
      ? this.config.openai.fineTuneModel 
      : this.config.openai.defaultModel;
  }

  getEnabledModules() {
    return this.config.modules;
  }

  updateConfig(config: any, reason: string) {
    this.config = { ...this.config, ...config };
    return { success: true, updated: true, reason };
  }
}