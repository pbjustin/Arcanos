/**
 * Tests for modular database structure
 */

import { describe, it, expect, jest } from '@jest/globals';

describe('Database Modular Structure', () => {
  it('should export all required functions from db/index.ts', async () => {
    const dbModule = await import('../src/db/index.js');
    
    expect(dbModule.initializeDatabase).toBeDefined();
    expect(dbModule.query).toBeDefined();
    expect(dbModule.transaction).toBeDefined();
    expect(dbModule.saveMemory).toBeDefined();
    expect(dbModule.loadMemory).toBeDefined();
    expect(dbModule.deleteMemory).toBeDefined();
    expect(dbModule.saveRagDoc).toBeDefined();
    expect(dbModule.loadAllRagDocs).toBeDefined();
    expect(dbModule.logExecution).toBeDefined();
    expect(dbModule.logExecutionBatch).toBeDefined();
    expect(dbModule.createJob).toBeDefined();
    expect(dbModule.updateJob).toBeDefined();
    expect(dbModule.getLatestJob).toBeDefined();
    expect(dbModule.logReasoning).toBeDefined();
    expect(dbModule.getStatus).toBeDefined();
    expect(dbModule.close).toBeDefined();
  });
  
  it('should export backward compatible db.ts module', async () => {
    const dbModule = await import('../src/db.js');
    
    expect(dbModule.initializeDatabase).toBeDefined();
    expect(dbModule.query).toBeDefined();
    expect(dbModule.saveMemory).toBeDefined();
    expect(dbModule.getStatus).toBeDefined();
  });
  
  it('should export Zod schemas from schema module', async () => {
    const schemaModule = await import('../src/db/schema.js');
    
    expect(schemaModule.MemoryEntrySchema).toBeDefined();
    expect(schemaModule.ExecutionLogSchema).toBeDefined();
    expect(schemaModule.JobDataSchema).toBeDefined();
    expect(schemaModule.ReasoningLogSchema).toBeDefined();
    expect(schemaModule.RagDocSchema).toBeDefined();
  });
});

describe('Health Endpoints', () => {
  it('should export health router', async () => {
    const healthRouter = await import('../src/routes/health.js');
    expect(healthRouter.default).toBeDefined();
  });
});

describe('Environment Validation', () => {
  it('should validate environment and return result', async () => {
    const { validateEnvironment } = await import('../src/utils/environmentValidation.js');
    
    const result = validateEnvironment();
    
    expect(result).toBeDefined();
    expect(result.isValid).toBeDefined();
    expect(result.errors).toBeDefined();
    expect(result.warnings).toBeDefined();
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
  
  it('should check for ephemeral filesystem', async () => {
    const { checkEphemeralFS } = await import('../src/utils/environmentValidation.js');
    
    // Should not throw
    expect(() => checkEphemeralFS()).not.toThrow();
  });
});

describe('CREPID Purge Utility', () => {
  it('should get purge mode from environment', async () => {
    const { getPurgeMode } = await import('../src/utils/crepidPurge.js');
    
    const mode = getPurgeMode();
    expect(['off', 'soft', 'hard']).toContain(mode);
  });
  
  it('should generate audit trail', async () => {
    const { generateAuditTrail } = await import('../src/utils/crepidPurge.js');
    
    const audit = generateAuditTrail('src/test.ts', 'test deprecation');
    
    expect(audit).toBeDefined();
    expect(audit.modulePath).toBe('src/test.ts');
    expect(audit.reason).toBe('test deprecation');
    expect(audit.removalRisk).toBeDefined();
    expect(['low', 'medium', 'high']).toContain(audit.removalRisk);
  });
});
