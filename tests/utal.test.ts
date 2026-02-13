import { detectTier } from "../src/core/logic/trinityTier.js";

describe("Unified Tier Authority (UTAL) - via TrinityTier", () => {
  it("should classify simple prompts as simple", () => {
    const tier = detectTier("How are you today?");
    expect(tier).toBe("simple");
  });

  it("should classify prompts with one critical keyword as complex", () => {
    // Upstream logic requires hitCount >= 1 for complex (or length > 300)
    const tier = detectTier("Tell me about the architecture.");
    expect(tier).toBe("complex");
  });

  it("should classify prompts with two or more critical keywords as critical", () => {
    // Upstream logic requires hitCount >= 2 AND length >= 500 for critical.
    // Let's test the hitCount part. 
    // Wait, upstream logic: if (normalized.length >= CRITICAL_LEN && hitCount >= 2) return 'critical';
    // So we need length too.
    const longPrompt = "Audit the security of this architecture. ".repeat(20);
    const tier = detectTier(longPrompt);
    expect(tier).toBe("critical");
  });

  it("should detect extra UTAL keywords like infrastructure and concurrency", () => {
    const tier = detectTier("Tell me about the infrastructure.");
    expect(tier).toBe("complex");
    
    const tier2 = detectTier("Explain concurrency.");
    expect(tier2).toBe("complex");
  });
});
