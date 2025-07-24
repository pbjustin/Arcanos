import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

export interface AssistantData {
  id: string;
  name: string;
  instructions: string | null;
  tools: any[];
  model: string;
}

export interface AssistantMap {
  [normalizedName: string]: AssistantData;
}

export class OpenAIAssistantsService {
  private client?: OpenAI;
  private configPath: string;

  constructor() {
    this.configPath = path.join(process.cwd(), 'config', 'assistants.json');

    // Only initialize OpenAI client if API key is available
    if (process.env.OPENAI_API_KEY) {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    } else {
      console.warn('[ASSISTANT-SYNC] OPENAI_API_KEY not provided - sync functionality will be limited');
    }
  }

  /**
   * Normalize assistant name to uppercase with underscores
   * e.g., "Arcanos Runtime Companion" -> "ARCANOS_RUNTIME_COMPANION"
   */
  private normalizeName(name: string): string {
    return name
      .trim()
      .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters except spaces
      .replace(/\s+/g, '_') // Replace spaces with underscores
      .toUpperCase();
  }

  /**
   * Test method to expose name normalization for testing
   */
  testNormalizeName(name: string): string {
    return this.normalizeName(name);
  }

  /**
   * Fetch all assistants from OpenAI API
   */
  async fetchAssistants(): Promise<AssistantData[]> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized - missing OPENAI_API_KEY');
    }

    try {
      console.log('[ASSISTANT-SYNC] Fetching assistants from OpenAI API...');
      
      const response = await this.client.beta.assistants.list({
        limit: 100, // Fetch up to 100 assistants
      });

      const assistants: AssistantData[] = response.data.map(assistant => ({
        id: assistant.id,
        name: assistant.name || 'Unnamed Assistant',
        instructions: assistant.instructions,
        tools: assistant.tools || [],
        model: assistant.model,
      }));

      console.log(`[ASSISTANT-SYNC] Found ${assistants.length} assistants`);
      return assistants;
    } catch (error: any) {
      console.error('[ASSISTANT-SYNC] Failed to fetch assistants:', error.message);
      throw new Error(`Failed to fetch assistants: ${error.message}`);
    }
  }

  /**
   * Sync assistants and save to config/assistants.json
   */
  async syncAssistants(): Promise<AssistantMap> {
    try {
      const assistants = await this.fetchAssistants();
      
      // Create map with normalized names as keys
      const assistantMap: AssistantMap = {};
      
      assistants.forEach(assistant => {
        const normalizedName = this.normalizeName(assistant.name);
        assistantMap[normalizedName] = assistant;
      });

      // Ensure config directory exists
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Save to file
      await this.saveAssistantsToFile(assistantMap);

      console.log(`[ASSISTANT-SYNC] Successfully synced ${Object.keys(assistantMap).length} assistants`);
      console.log('[ASSISTANT-SYNC] Normalized names:', Object.keys(assistantMap));
      
      return assistantMap;
    } catch (error: any) {
      console.error('[ASSISTANT-SYNC] Sync failed:', error.message);
      throw error;
    }
  }

  /**
   * Save assistants map to JSON file
   */
  private async saveAssistantsToFile(assistantMap: AssistantMap): Promise<void> {
    try {
      const jsonData = JSON.stringify(assistantMap, null, 2);
      fs.writeFileSync(this.configPath, jsonData, 'utf8');
      console.log(`[ASSISTANT-SYNC] Saved assistants to ${this.configPath}`);
    } catch (error: any) {
      console.error('[ASSISTANT-SYNC] Failed to save assistants file:', error.message);
      throw new Error(`Failed to save assistants file: ${error.message}`);
    }
  }

  /**
   * Load assistants from config file
   */
  async loadAssistants(): Promise<AssistantMap> {
    try {
      if (!fs.existsSync(this.configPath)) {
        console.log('[ASSISTANT-SYNC] Config file does not exist, returning empty map');
        return {};
      }

      const fileContent = fs.readFileSync(this.configPath, 'utf8');
      const assistantMap = JSON.parse(fileContent);
      
      console.log(`[ASSISTANT-SYNC] Loaded ${Object.keys(assistantMap).length} assistants from config`);
      return assistantMap;
    } catch (error: any) {
      console.error('[ASSISTANT-SYNC] Failed to load assistants config:', error.message);
      return {};
    }
  }

  /**
   * Get assistant by normalized name
   */
  async getAssistant(normalizedName: string): Promise<AssistantData | null> {
    const assistants = await this.loadAssistants();
    return assistants[normalizedName] || null;
  }

  /**
   * Get all assistant names (normalized)
   */
  async getAssistantNames(): Promise<string[]> {
    const assistants = await this.loadAssistants();
    return Object.keys(assistants);
  }
}

// Export singleton instance
export const openAIAssistantsService = new OpenAIAssistantsService();