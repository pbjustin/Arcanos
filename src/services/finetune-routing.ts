// Fine-Tuned Model Routing Override Service
// Implements the ARCANOS Shell command: "Force all prompts through my fine-tuned model until I say otherwise"

import { MemoryStorage, MemoryEntry } from '../storage/memory-storage';

export interface FineTuneRoutingState {
  active: boolean;
  activatedAt: Date;
  userId: string;
  sessionId: string;
  originalCommand: string;
}

export class FineTuneRoutingService {
  private memoryStorage: MemoryStorage;
  private routingStates: Map<string, FineTuneRoutingState> = new Map();
  
  constructor() {
    this.memoryStorage = new MemoryStorage();
  }

  /**
   * Check if a message is a fine-tune routing command
   */
  isFineTuneCommand(message: string): 'activate' | 'deactivate' | null {
    const normalizedMessage = message.toLowerCase().trim();
    
    // Activation patterns
    const activationPatterns = [
      'force all prompts through my fine-tuned model until i say otherwise',
      'force all prompts through my fine-tuned model',
      'route all prompts through fine-tuned model',
      'use fine-tuned model for all prompts',
      'activate fine-tune routing',
      'enable fine-tune override'
    ];

    // Deactivation patterns
    const deactivationPatterns = [
      'stop using fine-tuned model',
      'disable fine-tune routing',
      'deactivate fine-tune override',
      'stop forcing through fine-tuned model',
      'return to normal routing',
      'end fine-tune override'
    ];

    for (const pattern of activationPatterns) {
      if (normalizedMessage.includes(pattern)) {
        return 'activate';
      }
    }

    for (const pattern of deactivationPatterns) {
      if (normalizedMessage.includes(pattern)) {
        return 'deactivate';
      }
    }

    return null;
  }

  /**
   * Activate fine-tune routing for a user/session
   */
  async activateFineTuneRouting(
    userId: string = 'default',
    sessionId: string = 'default',
    originalCommand: string
  ): Promise<FineTuneRoutingState> {
    const state: FineTuneRoutingState = {
      active: true,
      activatedAt: new Date(),
      userId,
      sessionId,
      originalCommand
    };

    // Store in memory for current session
    this.routingStates.set(`${userId}:${sessionId}`, state);

    // Persist to storage for cross-session persistence
    try {
      await this.memoryStorage.storeMemory(
        userId,
        sessionId,
        'system',
        'finetune_routing_active',
        state,
        ['finetune', 'routing', 'override']
      );
      console.log('✅ Fine-tune routing activated and persisted for user:', userId);
    } catch (error) {
      console.warn('⚠️ Failed to persist fine-tune routing state:', error);
    }

    return state;
  }

  /**
   * Deactivate fine-tune routing for a user/session
   */
  async deactivateFineTuneRouting(
    userId: string = 'default',
    sessionId: string = 'default'
  ): Promise<boolean> {
    const key = `${userId}:${sessionId}`;
    
    // Remove from current session
    const wasActive = this.routingStates.has(key);
    this.routingStates.delete(key);

    // Remove from storage
    try {
      await this.memoryStorage.storeMemory(
        userId,
        sessionId,
        'system',
        'finetune_routing_active',
        { active: false, deactivatedAt: new Date() },
        ['finetune', 'routing', 'override', 'deactivated']
      );
      console.log('✅ Fine-tune routing deactivated for user:', userId);
    } catch (error) {
      console.warn('⚠️ Failed to persist fine-tune routing deactivation:', error);
    }

    return wasActive;
  }

  /**
   * Check if fine-tune routing is active for a user/session
   */
  async isFineTuneRoutingActive(
    userId: string = 'default',
    sessionId: string = 'default'
  ): Promise<boolean> {
    const key = `${userId}:${sessionId}`;
    
    // Check in-memory first (fastest)
    if (this.routingStates.has(key)) {
      return this.routingStates.get(key)!.active;
    }

    // Check persistent storage for cross-session state
    try {
      const memories = await this.memoryStorage.getMemoriesByUser(userId, 'system');
      const routingMemory = memories.find(m => 
        m.key === 'finetune_routing_active' && 
        m.sessionId === sessionId
      );

      if (routingMemory && routingMemory.value?.active) {
        // Restore state to in-memory cache
        this.routingStates.set(key, routingMemory.value);
        return true;
      }
    } catch (error) {
      console.warn('⚠️ Failed to check persistent fine-tune routing state:', error);
    }

    return false;
  }

  /**
   * Get the current routing state for a user/session
   */
  async getRoutingState(
    userId: string = 'default',
    sessionId: string = 'default'
  ): Promise<FineTuneRoutingState | null> {
    const key = `${userId}:${sessionId}`;
    
    if (this.routingStates.has(key)) {
      return this.routingStates.get(key)!;
    }

    // Check storage
    try {
      const memories = await this.memoryStorage.getMemoriesByUser(userId, 'system');
      const routingMemory = memories.find(m => 
        m.key === 'finetune_routing_active' && 
        m.sessionId === sessionId
      );

      if (routingMemory && routingMemory.value?.active) {
        return routingMemory.value;
      }
    } catch (error) {
      console.warn('⚠️ Failed to get routing state from storage:', error);
    }

    return null;
  }

  /**
   * Get status message for current routing state
   */
  async getStatusMessage(
    userId: string = 'default',
    sessionId: string = 'default'
  ): Promise<string> {
    const isActive = await this.isFineTuneRoutingActive(userId, sessionId);
    
    if (isActive) {
      const state = await this.getRoutingState(userId, sessionId);
      const duration = state ? 
        Math.round((Date.now() - state.activatedAt.getTime()) / 1000 / 60) : 0;
      
      return `🎯 Fine-tuned model routing is ACTIVE (${duration} minutes). All prompts are being routed through your fine-tuned model. Say "stop using fine-tuned model" to deactivate.`;
    } else {
      return `⭕ Fine-tuned model routing is INACTIVE. Normal intent-based routing is active. Say "Force all prompts through my fine-tuned model until I say otherwise" to activate override.`;
    }
  }
}

// Singleton instance for application-wide use
export const fineTuneRoutingService = new FineTuneRoutingService();