import express from 'express';
import * as http from 'http';
import { promisify } from 'util';
import { databaseService } from './database.js';
import { isTrue } from '../utils/env.js';

export class ServerService {
  private server: http.Server | null = null;

  async start(app: express.Application, port: number): Promise<void> {
    if (this.server) {
      throw new Error('Server already started');
    }
    
    this.server = http.createServer(app);
    
    // Use modern async/await with proper Promise wrapping for server.listen
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.listen(port, (err?: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
        
        // Handle server errors during startup
        this.server!.once('error', reject);
      });
      
      console.log(`[SERVER] Running on port ${port}`);
    } catch (error) {
      console.error(`[SERVER] Failed to start on port ${port}:`, error);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (!this.server) return;
    
    // Use modern async/await with proper Promise wrapping
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err?: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      
      console.log('✅ Server closed successfully');
      
      await databaseService.close();
      console.log('✅ Database pool closed');
    } catch (error) {
      console.error('❌ Error during server shutdown:', error);
      throw error;
    } finally {
      this.server = null;
    }
  }

  setupSignalHandlers(): void {
    const handler = async (signal: string) => {
      console.log(`[SIGNAL] ${signal} received.`);
      if (isTrue(process.env.RUN_WORKERS)) {
        console.log('[SIGNAL] RUN_WORKERS=true - gracefully shutting down...');
        try {
          await this.shutdown();
          process.exit(0);
        } catch (error) {
          console.error('❌ Error during shutdown:', error);
          process.exit(1);
        }
      } else {
        console.log('[SIGNAL] RUN_WORKERS not true - ignoring signal to keep server alive');
      }
    };
    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('SIGINT', () => handler('SIGINT'));
  }
}

export const serverService = new ServerService();
