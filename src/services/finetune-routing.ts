// Simplified Fine-Tuned Model Routing Service
// Basic routing override functionality without heavy memory persistence

export interface FineTuneRoutingState {
  active: boolean;
  activatedAt: Date;
  userId: string;
  sessionId: string;
}

export class FineTuneRoutingService {
  private routingStates: Map<string, FineTuneRoutingState> = new Map();

  constructor() {
    // No memory storage dependency - simplified version
  }

  /**
   * Check if a message is a fine-tune routing command
   */
  isFineTuneCommand(message: string): "activate" | "deactivate" | null {
    const normalizedMessage = message.toLowerCase().trim();

    // Simplified activation patterns
    if (
      normalizedMessage.includes(
        "force all prompts through my fine-tuned model",
      ) ||
      normalizedMessage.includes("activate fine-tune routing")
    ) {
      return "activate";
    }

    // Simplified deactivation patterns
    if (
      normalizedMessage.includes("stop using fine-tuned model") ||
      normalizedMessage.includes("disable fine-tune routing")
    ) {
      return "deactivate";
    }

    return null;
  }

  /**
   * Activate fine-tune routing for a user/session
   */
  async activateFineTuneRouting(
    userId: string = "default",
    sessionId: string = "default",
    originalCommand: string = "",
  ): Promise<FineTuneRoutingState> {
    const state: FineTuneRoutingState = {
      active: true,
      activatedAt: new Date(),
      userId,
      sessionId,
    };

    // Store in memory for current session only (no persistence)
    this.routingStates.set(`${userId}:${sessionId}`, state);
    console.log("✅ Fine-tune routing activated for user:", userId);

    return state;
  }

  /**
   * Deactivate fine-tune routing for a user/session
   */
  async deactivateFineTuneRouting(
    userId: string = "default",
    sessionId: string = "default",
  ): Promise<boolean> {
    const key = `${userId}:${sessionId}`;
    const wasActive = this.routingStates.has(key);
    this.routingStates.delete(key);
    console.log("✅ Fine-tune routing deactivated for user:", userId);
    return wasActive;
  }

  /**
   * Check if fine-tune routing is active for a user/session
   */
  async isFineTuneRoutingActive(
    userId: string = "default",
    sessionId: string = "default",
  ): Promise<boolean> {
    const key = `${userId}:${sessionId}`;
    return this.routingStates.has(key) && this.routingStates.get(key)!.active;
  }

  /**
   * Get the current routing state for a user/session
   */
  async getRoutingState(
    userId: string = "default",
    sessionId: string = "default",
  ): Promise<FineTuneRoutingState | null> {
    const key = `${userId}:${sessionId}`;
    return this.routingStates.get(key) || null;
  }

  /**
   * Get status message for current routing state
   */
  async getStatusMessage(
    userId: string = "default",
    sessionId: string = "default",
  ): Promise<string> {
    const isActive = await this.isFineTuneRoutingActive(userId, sessionId);

    if (isActive) {
      const state = await this.getRoutingState(userId, sessionId);
      const duration = state
        ? Math.round((Date.now() - state.activatedAt.getTime()) / 1000 / 60)
        : 0;

      return `🎯 Fine-tuned model routing is ACTIVE (${duration} minutes). All prompts are being routed through your fine-tuned model. Say "stop using fine-tuned model" to deactivate.`;
    } else {
      return `⭕ Fine-tuned model routing is INACTIVE. Normal intent-based routing is active. Say "Force all prompts through my fine-tuned model" to activate override.`;
    }
  }
}

// Singleton instance for application-wide use
export const fineTuneRoutingService = new FineTuneRoutingService();
