import { HRCCore } from './hrc';

export interface OverlayResult {
  allowed: boolean;
  route: 'allow' | 'throttle' | 'block';
  metrics: {
    resilience: number;
    fidelity: number;
    flagged?: boolean;
  };
}

export class HRCOverlay {
  private hrc: HRCCore;

  constructor(hrc?: HRCCore) {
    this.hrc = hrc || new HRCCore();
  }

  async evaluate(message: string, domain: string): Promise<OverlayResult> {
    const validation = await this.hrc.validate(message, { domain });
    const resScore = validation.data?.resilienceScore ?? 1;
    const fidScore = validation.data?.fidelityScore ?? 1;
    let route: 'allow' | 'throttle' | 'block' = 'allow';

    if (!validation.success) {
      route = 'block';
    } else if (resScore < 0.5 || fidScore < 0.5) {
      route = 'throttle';
    }

    return {
      allowed: route === 'allow',
      route,
      metrics: {
        resilience: resScore,
        fidelity: fidScore,
        flagged: validation.data?.flagged,
      },
    };
  }
}
