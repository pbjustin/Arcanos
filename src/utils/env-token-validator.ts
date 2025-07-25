import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface TokenValidationResult {
  isValid: boolean;
  isRailway: boolean;
  tokenExists: boolean;
  requiresUpdate: boolean;
  message: string;
}

export interface EnvUpdateResult {
  success: boolean;
  message: string;
  requiresReload: boolean;
}

/**
 * Validates ARCANOS_API_TOKEN for Railway environment
 */
export class EnvTokenValidator {
  private static readonly ENV_FILE_PATH = path.join(process.cwd(), '.env');
  
  /**
   * Check if running in Railway environment
   */
  static isRailwayEnvironment(): boolean {
    return !!(process.env.RAILWAY_ENVIRONMENT || 
             process.env.RAILWAY_PROJECT_ID || 
             process.env.RAILWAY_SERVICE_ID ||
             process.env.RAILWAY_PROJECT);
  }

  /**
   * Validate ARCANOS_API_TOKEN configuration
   */
  static async validateToken(): Promise<TokenValidationResult> {
    const isRailway = this.isRailwayEnvironment();
    const tokenExists = !!(process.env.ARCANOS_API_TOKEN);
    
    if (!isRailway) {
      return {
        isValid: true,
        isRailway: false,
        tokenExists,
        requiresUpdate: false,
        message: 'Not running in Railway environment - token validation skipped'
      };
    }

    if (!tokenExists) {
      return {
        isValid: false,
        isRailway: true,
        tokenExists: false,
        requiresUpdate: true,
        message: '🚨 ARCANOS_API_TOKEN is required in Railway environment but not found'
      };
    }

    // Validate token format (should be a secure string)
    const token = process.env.ARCANOS_API_TOKEN;
    if (token && token.length < 16) {
      return {
        isValid: false,
        isRailway: true,
        tokenExists: true,
        requiresUpdate: true,
        message: '🚨 ARCANOS_API_TOKEN exists but appears insecure (less than 16 characters)'
      };
    }

    return {
      isValid: true,
      isRailway: true,
      tokenExists: true,
      requiresUpdate: false,
      message: '✅ ARCANOS_API_TOKEN is properly configured'
    };
  }

  /**
   * Generate a secure token
   */
  static generateSecureToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Prompt user for token update with secure input
   */
  static async promptForToken(): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    console.log('\n🔐 ARCANOS_API_TOKEN Configuration Required');
    console.log('━'.repeat(50));
    console.log('This Railway deployment requires a secure API token for ARCANOS routing.');
    console.log('');
    
    return new Promise((resolve) => {
      const suggestedToken = this.generateSecureToken();
      console.log(`💡 Suggested secure token: ${suggestedToken}`);
      console.log('');
      
      rl.question('Enter ARCANOS_API_TOKEN (or press Enter to use suggested): ', (answer) => {
        rl.close();
        const token = answer.trim() || suggestedToken;
        resolve(token);
      });
    });
  }

  /**
   * Update .env file with new token
   */
  static async updateEnvFile(token: string): Promise<EnvUpdateResult> {
    try {
      let envContent = '';
      let tokenLineExists = false;

      // Read existing .env file if it exists
      if (fs.existsSync(this.ENV_FILE_PATH)) {
        envContent = fs.readFileSync(this.ENV_FILE_PATH, 'utf8');
        
        // Check if ARCANOS_API_TOKEN line already exists
        const lines = envContent.split('\n');
        const updatedLines = lines.map(line => {
          if (line.startsWith('ARCANOS_API_TOKEN=')) {
            tokenLineExists = true;
            return `ARCANOS_API_TOKEN=${token}`;
          }
          return line;
        });

        if (tokenLineExists) {
          envContent = updatedLines.join('\n');
        } else {
          // Add token to end of file
          envContent = envContent.trim() + `\nARCANOS_API_TOKEN=${token}\n`;
        }
      } else {
        // Create new .env file
        envContent = `ARCANOS_API_TOKEN=${token}\n`;
      }

      // Write updated content
      fs.writeFileSync(this.ENV_FILE_PATH, envContent, 'utf8');

      // Update process.env immediately
      process.env.ARCANOS_API_TOKEN = token;

      return {
        success: true,
        message: `✅ ARCANOS_API_TOKEN updated successfully in ${this.ENV_FILE_PATH}`,
        requiresReload: true
      };

    } catch (error: any) {
      return {
        success: false,
        message: `❌ Failed to update .env file: ${error.message}`,
        requiresReload: false
      };
    }
  }

  /**
   * Complete token validation and update flow
   */
  static async validateAndPromptIfNeeded(): Promise<boolean> {
    const validation = await this.validateToken();
    
    console.log(`\n🔍 Token Validation: ${validation.message}`);
    
    if (!validation.requiresUpdate) {
      return true;
    }

    if (!validation.isRailway) {
      console.log('ℹ️ Running in development mode - ARCANOS_API_TOKEN is optional');
      return true;
    }

    try {
      console.log('\n⚠️ Missing or invalid ARCANOS_API_TOKEN detected in Railway environment');
      console.log('🔧 Starting secure token configuration...');
      
      const token = await this.promptForToken();
      const updateResult = await this.updateEnvFile(token);
      
      console.log(`\n${updateResult.message}`);
      
      if (updateResult.success && updateResult.requiresReload) {
        console.log('\n🔄 Token updated successfully! Server will reload to apply changes...');
        console.log('📋 New token configured for ARCANOS routing endpoints');
        
        // Trigger server reload after a short delay
        setTimeout(() => {
          console.log('\n♻️ Reloading server with new configuration...');
          process.exit(0); // Railway will restart the service
        }, 2000);
        
        return true;
      }
      
      return updateResult.success;
      
    } catch (error: any) {
      console.error(`❌ Token configuration failed: ${error.message}`);
      return false;
    }
  }
}