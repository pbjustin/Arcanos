import { HRCCore } from './hrc.js';

export interface OverlayResult {
  allowed: boolean;
  route: 'allow' | 'throttle' | 'block';
  metrics: {
    resilience: number;
    fidelity: number;
    flagged?: boolean;
    failsafeReady?: boolean;
    rollbackCapable?: boolean;
  };
  resiliencePatches?: {
    failsafeEnabled: boolean;
    rollbackEnabled: boolean;
    isolatedRollback: boolean;
  };
}

export class HRCOverlay {
  private hrc: HRCCore;
  private resiliencePatchesEnabled: boolean = true;

  constructor(hrc?: HRCCore) {
    this.hrc = hrc || new HRCCore();
  }

  async evaluate(message: string, domain: string): Promise<OverlayResult> {
    const validation = await this.hrc.validate(message, { domain });
    const resScore = validation.data?.resilienceScore ?? 1;
    const fidScore = validation.data?.fidelityScore ?? 1;
    let route: 'allow' | 'throttle' | 'block' = 'allow';

    // Enhanced routing logic with resilience patches
    if (!validation.success) {
      route = 'block';
    } else if (resScore < 0.5 || fidScore < 0.5) {
      // Check if resilience patches can help
      if (this.resiliencePatchesEnabled && this.canApplyResiliencePatches(validation.data)) {
        route = 'throttle'; // Allow with throttling instead of blocking
      } else {
        route = 'throttle';
      }
    }

    // Determine failsafe and rollback capabilities
    const failsafeReady = validation.data?.enhancedResilience?.failsafePatternDetection || 
                         this.detectFailsafeReadiness(message);
    const rollbackCapable = validation.data?.enhancedResilience?.rollbackSafetyDetection || 
                           this.detectRollbackCapability(message);

    return {
      allowed: route === 'allow',
      route,
      metrics: {
        resilience: resScore,
        fidelity: fidScore,
        flagged: validation.data?.flagged,
        failsafeReady,
        rollbackCapable
      },
      resiliencePatches: this.resiliencePatchesEnabled ? {
        failsafeEnabled: true,
        rollbackEnabled: true,
        isolatedRollback: true
      } : undefined
    };
  }

  private canApplyResiliencePatches(validationData: any): boolean {
    // Check if resilience patches can improve the situation
    const hasFailsafeIndicators = validationData?.enhancedResilience?.failsafePatternDetection;
    const hasRollbackSafety = validationData?.enhancedResilience?.rollbackSafetyDetection;
    
    return hasFailsafeIndicators || hasRollbackSafety || validationData?.resilienceScore > 0.3;
  }

  private detectFailsafeReadiness(message: string): boolean {
    const failsafeIndicators = [
      /checkpoint/i, /save.*state/i, /backup/i, /failsafe/i, /recovery/i
    ];
    return failsafeIndicators.some(pattern => pattern.test(message));
  }

  private detectRollbackCapability(message: string): boolean {
    const rollbackIndicators = [
      /rollback/i, /undo/i, /revert/i, /restore/i, /previous.*state/i
    ];
    return rollbackIndicators.some(pattern => pattern.test(message));
  }

  /**
   * Enable or disable resilience patches
   */
  setResiliencePatches(enabled: boolean): void {
    this.resiliencePatchesEnabled = enabled;
  }
}
