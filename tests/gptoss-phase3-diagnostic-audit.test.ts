import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const auditSource = readFileSync(join(process.cwd(), 'scripts', 'gptoss', 'phase3-diagnostic-audit.py'), 'utf8');
const wrapperSource = readFileSync(join(process.cwd(), 'scripts', 'gptoss', 'phase3-diagnostic-audit.mjs'), 'utf8');

describe('phase3 diagnostic audit', () => {
  it('writes only local phase3 diagnostic reports', () => {
    expect(auditSource).toContain('phase3_1_failure_inspection.json');
    expect(auditSource).toContain('token-boundary-alignment.json');
    expect(auditSource).toContain('target-shape-audit.json');
    expect(auditSource).toContain('lora-training-config-audit.json');
    expect(auditSource).toContain('decode-audit.json');
    expect(auditSource).toContain('phase3_next_decision.json');
    expect(auditSource).toContain('DEFAULT_ARTIFACT_DIR');
  });

  it('checks Harmony boundary tokens between eval prefix and assistant target', () => {
    expect(auditSource).toContain('targetStartsImmediatelyAfterB');
    expect(auditSource).toContain('extraBoundaryTextBetweenPrefixAndTarget');
    expect(auditSource).toContain('labelsSuperviseRequiredAssistantBoundaryTokens');
    expect(auditSource).toContain('full_text.startswith(prefix_text)');
  });

  it('keeps the diagnostic path local and non-training', () => {
    expect(auditSource).toContain('"openAiCalled": False');
    expect(auditSource).toContain('"vllmCalled": False');
    expect(auditSource).toContain('"trainingExecuted": False');
    expect(auditSource).not.toContain('api.openai.com');
    expect(auditSource).not.toContain('model.generate(');
    expect(auditSource).not.toContain('trainer.train(');
    expect(wrapperSource).toContain('phase3-diagnostic-audit.py');
  });
});
