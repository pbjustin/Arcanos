import * as readline from 'readline';

export class PermissionManager {
  private static instance: PermissionManager;
  private fallbackPermissions: Map<string, boolean> = new Map();
  private pendingPrompts: Map<string, Promise<boolean>> = new Map();

  public static getInstance(): PermissionManager {
    if (!PermissionManager.instance) {
      PermissionManager.instance = new PermissionManager();
    }
    return PermissionManager.instance;
  }

  /**
   * Request permission to fallback from fine-tune model to default model
   * @param reason The reason why fallback is needed
   * @returns Promise<boolean> - true if permission granted, false otherwise
   */
  async requestFallbackPermission(reason: string): Promise<boolean> {
    const permissionKey = `fallback_${Date.now()}`;
    
    // Check if we already have a pending prompt for this scenario
    const existingPrompt = this.pendingPrompts.get('fallback_general');
    if (existingPrompt) {
      console.log('[PermissionManager] Using existing pending permission prompt...');
      return existingPrompt;
    }

    // Create new permission request
    const permissionPromise = this.createInteractivePrompt(reason);
    this.pendingPrompts.set('fallback_general', permissionPromise);

    try {
      const result = await permissionPromise;
      this.fallbackPermissions.set(permissionKey, result);
      return result;
    } finally {
      this.pendingPrompts.delete('fallback_general');
    }
  }

  /**
   * Create an interactive console prompt for permission
   * @param reason The reason for the permission request
   * @returns Promise<boolean>
   */
  private createInteractivePrompt(reason: string): Promise<boolean> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      console.log('\n' + '='.repeat(80));
      console.log('🚨 ARCANOS PERMISSION REQUEST 🚨');
      console.log('='.repeat(80));
      console.log(`Issue: ${reason}`);
      console.log('I cannot access your fine-tune model.');
      console.log('Would you like me to fall back to the default model (gpt-3.5-turbo)?');
      console.log('='.repeat(80));
      
      const askQuestion = () => {
        rl.question('Allow fallback to default model? (yes/no): ', (answer) => {
          const normalizedAnswer = answer.toLowerCase().trim();
          
          if (normalizedAnswer === 'yes' || normalizedAnswer === 'y') {
            console.log('✅ Permission granted - Using default model for this session');
            rl.close();
            resolve(true);
          } else if (normalizedAnswer === 'no' || normalizedAnswer === 'n') {
            console.log('❌ Permission denied - Will continue to throw errors');
            rl.close();
            resolve(false);
          } else {
            console.log('Please answer "yes" or "no"');
            askQuestion();
          }
        });
      };

      askQuestion();
    });
  }

  /**
   * Check if fallback permission has been granted for current session
   * @returns boolean
   */
  hasFallbackPermission(): boolean {
    // Check if any fallback permission has been granted in current session
    return Array.from(this.fallbackPermissions.values()).some(permission => permission === true);
  }

  /**
   * Grant fallback permission programmatically (for API endpoint)
   * @param granted boolean - whether permission is granted
   */
  setFallbackPermission(granted: boolean): void {
    const permissionKey = `api_fallback_${Date.now()}`;
    this.fallbackPermissions.set(permissionKey, granted);
    console.log(`[PermissionManager] Fallback permission ${granted ? 'granted' : 'denied'} via API`);
  }

  /**
   * Reset all permissions (useful for testing or session reset)
   */
  resetPermissions(): void {
    this.fallbackPermissions.clear();
    console.log('[PermissionManager] All permissions reset');
  }

  /**
   * Get current permission status
   */
  getPermissionStatus() {
    return {
      hasFallbackPermission: this.hasFallbackPermission(),
      totalPermissions: this.fallbackPermissions.size,
      pendingPrompts: this.pendingPrompts.size
    };
  }
}