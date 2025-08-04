import axios from 'axios';

interface ChatGPTUserConfig {
  prefixes: string[];
}

/**
 * Service to manage ChatGPT-User IP whitelist
 * Fetches and caches IP ranges from OpenAI endpoint with hourly refresh
 */
class ChatGPTUserWhitelistService {
  private ipPrefixes: string[] = [];
  private lastFetchTime: number = 0;
  private readonly CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds
  private readonly OPENAI_ENDPOINT = 'https://openai.com/chatgpt-user.json';
  private fetchInProgress = false;

  /**
   * Check if an IP address is whitelisted
   */
  async isIpWhitelisted(ip: string): Promise<boolean> {
    await this.ensureFreshCache();
    
    // Check if IP matches any prefix
    return this.ipPrefixes.some(prefix => {
      // Simple prefix matching - could be enhanced with proper CIDR matching
      return ip.startsWith(prefix);
    });
  }

  /**
   * Get current IP prefixes for diagnostics
   */
  getCurrentPrefixes(): string[] {
    return [...this.ipPrefixes];
  }

  /**
   * Get cache status for diagnostics
   */
  getCacheStatus(): { lastFetch: number; isStale: boolean; prefixCount: number } {
    const now = Date.now();
    const isStale = (now - this.lastFetchTime) > this.CACHE_DURATION;
    
    return {
      lastFetch: this.lastFetchTime,
      isStale,
      prefixCount: this.ipPrefixes.length
    };
  }

  /**
   * Ensure cache is fresh, refresh if needed
   */
  private async ensureFreshCache(): Promise<void> {
    const now = Date.now();
    const cacheAge = now - this.lastFetchTime;
    
    // Skip if cache is fresh or fetch already in progress
    if (cacheAge < this.CACHE_DURATION || this.fetchInProgress) {
      return;
    }

    await this.refreshCache();
  }

  /**
   * Force refresh the IP whitelist cache
   */
  async refreshCache(): Promise<boolean> {
    if (this.fetchInProgress) {
      return false;
    }

    this.fetchInProgress = true;
    
    try {
      console.log('[CHATGPT-USER] Fetching IP whitelist from OpenAI...');
      
      const response = await axios.get<ChatGPTUserConfig>(this.OPENAI_ENDPOINT, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Arcanos-Backend/1.0.0'
        }
      });

      if (response.data && Array.isArray(response.data.prefixes)) {
        this.ipPrefixes = response.data.prefixes;
        this.lastFetchTime = Date.now();
        
        console.log(`[CHATGPT-USER] ✅ Updated whitelist with ${this.ipPrefixes.length} IP prefixes`);
        return true;
      } else {
        console.warn('[CHATGPT-USER] ⚠️ Invalid response format from OpenAI endpoint');
        return false;
      }
      
    } catch (error: any) {
      console.error('[CHATGPT-USER] ❌ Failed to fetch IP whitelist:', error.message);
      
      // Fail safely - keep existing cache if available
      if (this.ipPrefixes.length > 0) {
        console.warn('[CHATGPT-USER] Using stale cache due to fetch failure');
      }
      
      return false;
    } finally {
      this.fetchInProgress = false;
    }
  }

  /**
   * Initialize the service with initial cache population
   */
  async initialize(): Promise<void> {
    console.log('[CHATGPT-USER] Initializing IP whitelist service...');
    await this.refreshCache();
  }
}

// Export singleton instance
export const chatGPTUserWhitelist = new ChatGPTUserWhitelistService();