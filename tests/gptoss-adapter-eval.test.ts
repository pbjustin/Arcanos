import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = join(process.cwd(), 'scripts', 'gptoss', 'eval-adapter-local.py');
const evalFile = join(process.cwd(), 'examples', 'gptoss', 'arcanos-eval-smoke.jsonl');
const microEvalFile = join(process.cwd(), 'examples', 'gptoss', 'arcanos-micro-overfit-eval.jsonl');
const singleJsonEvalFile = join(process.cwd(), 'examples', 'gptoss', 'arcanos-single-json-overfit-eval.jsonl');
const singleSafetyEvalFile = join(process.cwd(), 'examples', 'gptoss', 'arcanos-single-safety-overfit-eval.jsonl');

function runPython(args: string[]) {
  return spawnSync('python', [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function runExtraction(raw: string, expectsJson: boolean) {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("eval_adapter", ${JSON.stringify(scriptPath)})`,
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    `result = module.extract_final_output(${JSON.stringify(raw)}, ${expectsJson ? 'True' : 'False'})`,
    'print(json.dumps(result))',
  ].join('; ');
  const completed = spawnSync('python', ['-c', code], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (completed.status !== 0) {
    throw new Error(completed.stderr || completed.stdout);
  }
  return JSON.parse(completed.stdout);
}

function runEvaluation(record: Record<string, unknown>, output: string) {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("eval_adapter", ${JSON.stringify(scriptPath)})`,
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    `record = json.loads(${JSON.stringify(JSON.stringify(record))})`,
    `result = module.evaluate_output(record, ${JSON.stringify(output)})`,
    'print(json.dumps(result))',
  ].join('; ');
  const completed = spawnSync('python', ['-c', code], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (completed.status !== 0) {
    throw new Error(completed.stderr || completed.stdout);
  }
  return JSON.parse(completed.stdout);
}

function runPythonSnippet(lines: string[]) {
  const code = [
    'import argparse, importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("eval_adapter", ${JSON.stringify(scriptPath)})`,
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    ...lines,
  ].join('\n');
  const completed = spawnSync('python', ['-c', code], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (completed.status !== 0) {
    throw new Error(completed.stderr || completed.stdout);
  }
  return JSON.parse(completed.stdout);
}

function runComparisonScoring() {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("eval_adapter", ${JSON.stringify(scriptPath)})`,
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'records = [{"id":"cmp-1","expected":{"must_include":["control"]}},{"id":"cmp-2","expected":{"must_include":["TypeScript"]}}]',
    'base_report = {"allowedForTraining":False,"openAiCalled":False,"trainingExecuted":False,"vllmUsed":False}',
    'comparison = {"base":{"outputs":{"cmp-1":{"rawGeneratedText":"wrong","finalText":"wrong","finalExtractionApplied":False,"finalExtractionReason":"none"},"cmp-2":{"rawGeneratedText":"TypeScript","finalText":"TypeScript","finalExtractionApplied":False,"finalExtractionReason":"none"}},"chatTemplateUsed":True,"chatTemplateFallbackUsed":False,"decoding":{"maxNewTokens":32}},"adapter":{"outputs":{"cmp-1":{"rawGeneratedText":"control","finalText":"control","finalExtractionApplied":False,"finalExtractionReason":"none"},"cmp-2":{"rawGeneratedText":"wrong","finalText":"wrong","finalExtractionApplied":False,"finalExtractionReason":"none"}},"chatTemplateUsed":True,"chatTemplateFallbackUsed":False,"decoding":{"maxNewTokens":32}}}',
    'result = module.score_comparison_outputs(base_report, records, comparison)',
    'print(json.dumps(result))',
  ].join('; ');
  const completed = spawnSync('python', ['-c', code], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (completed.status !== 0) {
    throw new Error(completed.stderr || completed.stdout);
  }
  return JSON.parse(completed.stdout);
}

function makeAdapter(metadata: Record<string, unknown> = { noOpenAiOutputUsed: true }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'arcanos-adapter-eval-'));
  const adapterDir = join(tempDir, 'adapter');
  const outputPath = join(process.cwd(), 'local_artifacts', 'adapter-eval-test-report.json');
  writeFileSync(join(tempDir, 'placeholder'), '', 'utf8');
  return { tempDir, adapterDir, outputPath, metadata };
}

function writeAdapterFixture(adapterDir: string, metadata: Record<string, unknown>) {
  mkdirSync(adapterDir, { recursive: true });
  writeFileSync(join(adapterDir, 'adapter_config.json'), '{}\n', 'utf8');
  writeFileSync(join(adapterDir, 'adapter_model.safetensors'), 'adapter\n', 'utf8');
  writeFileSync(join(adapterDir, 'adapter-metadata.json'), `${JSON.stringify(metadata)}\n`, 'utf8');
}

describe('gptoss adapter local eval', () => {
  it('fails clearly when the adapter directory is missing', () => {
    const result = runPython(['--dry-run', '--adapter-dir', join(tmpdir(), 'missing-arcanos-adapter'), '--eval-file', evalFile]);
    const parsed = JSON.parse(result.stdout);
    expect(result.status).toBe(2);
    expect(parsed).toMatchObject({
      ok: false,
      error: 'preflight_failed',
      allowedForTraining: false,
      openAiCalled: false,
    });
    expect(parsed.message).toContain('adapter directory is missing');
  });

  it('requires adapter metadata to confirm no OpenAI output was used', () => {
    const fixture = makeAdapter({ noOpenAiOutputUsed: false });
    try {
      writeAdapterFixture(fixture.adapterDir, fixture.metadata);
      const result = runPython(['--dry-run', '--adapter-dir', fixture.adapterDir, '--eval-file', evalFile, '--output', fixture.outputPath]);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(2);
      expect(parsed.message).toContain('noOpenAiOutputUsed=true');
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('keeps dry-run reports local, non-training, and OpenAI-free', () => {
    const fixture = makeAdapter();
    try {
      writeAdapterFixture(fixture.adapterDir, fixture.metadata);
      const result = runPython(['--dry-run', '--adapter-dir', fixture.adapterDir, '--eval-file', evalFile, '--output', fixture.outputPath, '--max-records', '1']);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(parsed).toMatchObject({
        ok: true,
        mode: 'dry-run',
        executed: false,
        records: 1,
        chatTemplateUsed: false,
        chatTemplateFallbackUsed: false,
        allowedForTraining: false,
        openAiCalled: false,
        noOpenAiOutputUsed: true,
        trainingExecuted: false,
        vllmUsed: false,
      });
      expect(parsed.decoding).toMatchObject({
        maxNewTokens: 96,
        temperature: 0.1,
        topP: 0.9,
        repetitionPenalty: 1.15,
        doSample: true,
        eosTokenIdPresent: false,
        padTokenIdPresent: false,
      });
      expect(parsed.reportPath).toContain('local_artifacts');
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('keeps micro eval reports local, non-training, and OpenAI-free in dry-run mode', () => {
    const fixture = makeAdapter();
    try {
      writeAdapterFixture(fixture.adapterDir, fixture.metadata);
      const result = runPython(['--dry-run', '--adapter-dir', fixture.adapterDir, '--eval-file', microEvalFile, '--output', fixture.outputPath]);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(parsed).toMatchObject({
        ok: true,
        mode: 'dry-run',
        executed: false,
        records: 3,
        allowedForTraining: false,
        openAiCalled: false,
        noOpenAiOutputUsed: true,
        trainingExecuted: false,
        vllmUsed: false,
      });
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('keeps single-record eval reports local, non-training, and OpenAI-free in dry-run mode', () => {
    for (const evalFilePath of [singleJsonEvalFile, singleSafetyEvalFile]) {
      const fixture = makeAdapter();
      try {
        writeAdapterFixture(fixture.adapterDir, fixture.metadata);
        const result = runPython(['--dry-run', '--adapter-dir', fixture.adapterDir, '--eval-file', evalFilePath, '--output', fixture.outputPath]);
        const parsed = JSON.parse(result.stdout);
        expect(result.status).toBe(0);
        expect(parsed).toMatchObject({
          ok: true,
          mode: 'dry-run',
          executed: false,
          records: 1,
          allowedForTraining: false,
          openAiCalled: false,
          noOpenAiOutputUsed: true,
          trainingExecuted: false,
          vllmUsed: false,
        });
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  });

  it('reflects final-channel forcing in dry-run report config', () => {
    const fixture = makeAdapter();
    try {
      writeAdapterFixture(fixture.adapterDir, fixture.metadata);
      const result = runPython(['--dry-run', '--adapter-dir', fixture.adapterDir, '--eval-file', singleJsonEvalFile, '--output', fixture.outputPath, '--force-final-channel']);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(parsed.forceFinalChannel).toBe(true);
      expect(parsed.diagnosticModes.forceFinalChannel).toBe(true);
      expect(parsed.allowedForTraining).toBe(false);
      expect(parsed.openAiCalled).toBe(false);
      expect(parsed.trainingExecuted).toBe(false);
      expect(parsed.vllmUsed).toBe(false);
      expect(parsed.noOpenAiOutputUsed).toBe(true);
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('reflects JSON prefill in dry-run report config', () => {
    const fixture = makeAdapter();
    try {
      writeAdapterFixture(fixture.adapterDir, fixture.metadata);
      const result = runPython(['--dry-run', '--adapter-dir', fixture.adapterDir, '--eval-file', singleJsonEvalFile, '--output', fixture.outputPath, '--prefill-json-start']);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(parsed.prefillJsonStart).toBe(true);
      expect(parsed.diagnosticModes.prefillJsonStart).toBe(true);
      expect(parsed.allowedForTraining).toBe(false);
      expect(parsed.openAiCalled).toBe(false);
      expect(parsed.trainingExecuted).toBe(false);
      expect(parsed.vllmUsed).toBe(false);
      expect(parsed.noOpenAiOutputUsed).toBe(true);
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('plans a bounded base-vs-adapter comparison in dry-run mode', () => {
    const fixture = makeAdapter();
    try {
      writeAdapterFixture(fixture.adapterDir, fixture.metadata);
      const result = runPython([
        '--dry-run',
        '--compare-base-adapter',
        '--adapter-dir',
        fixture.adapterDir,
        '--eval-file',
        evalFile,
        '--output',
        fixture.outputPath,
        '--max-records',
        '3',
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(parsed.compareBaseAdapter).toBe(true);
      expect(parsed.baseVsAdapterComparison).toMatchObject({
        planned: true,
        maxRecords: 3,
      });
      expect(parsed.allowedForTraining).toBe(false);
      expect(parsed.openAiCalled).toBe(false);
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('defaults compare mode to three records when max-records is omitted', () => {
    const fixture = makeAdapter();
    try {
      writeAdapterFixture(fixture.adapterDir, fixture.metadata);
      const result = runPython([
        '--dry-run',
        '--compare-base-adapter',
        '--adapter-dir',
        fixture.adapterDir,
        '--eval-file',
        evalFile,
        '--output',
        fixture.outputPath,
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(parsed.records).toBe(3);
      expect(parsed.maxNewTokens).toBe(32);
      expect(parsed.decoding.doSample).toBe(false);
      expect(parsed.decoding.temperature).toBe(0);
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('builds true base and adapter comparison report sections', () => {
    const parsed = runComparisonScoring();
    expect(parsed).toMatchObject({
      compareBaseAdapter: true,
      baseRecordsEvaluated: 2,
      adapterRecordsEvaluated: 2,
      basePassed: 1,
      adapterPassed: 1,
      adapterImprovedCount: 1,
      adapterRegressedCount: 1,
      sameOutcomeCount: 0,
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
    });
    expect(parsed.comparisons[0]).toMatchObject({
      id: 'cmp-1',
      base: { generated: true, passed: false },
      adapter: { generated: true, passed: true },
      delta: { adapterImproved: true, adapterRegressed: false, sameOutcome: false },
    });
  });

  it('extracts final text from analysis-like generated output', () => {
    const parsed = runExtraction('analysisThe user asks a question. Final answer: control-plane', false);
    expect(parsed).toEqual({
      finalText: 'control-plane',
      finalExtractionApplied: true,
      finalExtractionReason: 'final_marker',
    });
  });

  it('extracts the first valid JSON object for JSON evals', () => {
    const parsed = runExtraction('.assistantanalysis Reasoning text. Thus {"allowedForTraining":false,"passed":0}', true);
    expect(parsed).toEqual({
      finalText: '{"allowedForTraining":false,"passed":0}',
      finalExtractionApplied: true,
      finalExtractionReason: 'first_json_object',
    });
  });

  it('keeps invalid JSON strict after final extraction', () => {
    const parsed = runExtraction('analysisThe user wants JSON but no object follows.', true);
    expect(parsed.finalText).toBe('The user wants JSON but no object follows.');
    expect(parsed.finalExtractionApplied).toBe(true);
  });

  it('slices generated tokens before decoding', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('new_tokens = generated[0][inputs["input_ids"].shape[-1]:]');
    expect(source).toContain('tokenizer.decode(new_tokens, skip_special_tokens=True)');
  });

  it('derives and applies a final-channel boundary before JSON prefill', () => {
    const parsed = runPythonSnippet([
      'class FakeHarmonyTokenizer:',
      '    chat_template = "fake-harmony"',
      '    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):',
      '        text = ""',
      '        for message in messages:',
      '            if message["role"] == "assistant":',
      '                text += f"<|start|>assistant<|channel|>final<|message|>{message[\'content\']}<|end|>"',
      '            else:',
      '                text += f"<|start|>{message[\'role\']}<|message|>{message[\'content\']}<|end|>"',
      '        if add_generation_prompt:',
      '            text += "<|start|>assistant"',
      '        return self.encode(text) if tokenize else text',
      '    def __call__(self, text, add_special_tokens=False, **kwargs):',
      '        return {"input_ids": self.encode(text), "attention_mask": [1] * len(text)}',
      '    def decode(self, token_ids, skip_special_tokens=False):',
      '        return "".join(chr(token_id) for token_id in token_ids)',
      '    def encode(self, text):',
      '        return [ord(char) for char in text]',
      'record = {"id":"json","prompt":"Return JSON.","expected":{"json_object":True,"must_include":["validate_dataset"]}}',
      'options = argparse.Namespace(force_final_channel=True, prefill_json_start=True)',
      'prompt, used_template, diagnostics = module.build_prompt(FakeHarmonyTokenizer(), record, options)',
      'print(json.dumps({"promptTail": prompt[-80:], "usedTemplate": used_template, **diagnostics}))',
    ]);
    expect(parsed.usedTemplate).toBe(true);
    expect(parsed.promptTail).toContain('<|channel|>final<|message|>{');
    expect(parsed.prefixAppearsFinalChannel).toBe(true);
    expect(parsed.finalChannelBoundaryApplied).toBe(true);
    expect(parsed.finalChannelBoundarySource).toBe('tokenizer_derived');
    expect(parsed.finalBoundaryTokenIds.length).toBeGreaterThan(0);
    expect(parsed.jsonPrefillApplied).toBe(true);
    expect(parsed.jsonPrefillText).toBe('{');
  });

  it('does not apply JSON prefill to non-JSON records', () => {
    const parsed = runPythonSnippet([
      'class FakeHarmonyTokenizer:',
      '    chat_template = "fake-harmony"',
      '    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):',
      '        text = ""',
      '        for message in messages:',
      '            if message["role"] == "assistant":',
      '                text += f"<|start|>assistant<|channel|>final<|message|>{message[\'content\']}<|end|>"',
      '            else:',
      '                text += f"<|start|>{message[\'role\']}<|message|>{message[\'content\']}<|end|>"',
      '        if add_generation_prompt:',
      '            text += "<|start|>assistant"',
      '        return self.encode(text) if tokenize else text',
      '    def __call__(self, text, add_special_tokens=False, **kwargs):',
      '        return {"input_ids": self.encode(text), "attention_mask": [1] * len(text)}',
      '    def decode(self, token_ids, skip_special_tokens=False):',
      '        return "".join(chr(token_id) for token_id in token_ids)',
      '    def encode(self, text):',
      '        return [ord(char) for char in text]',
      'record = {"id":"label","prompt":"Return label.","expected":{"must_include":["control-plane"]}}',
      'options = argparse.Namespace(force_final_channel=True, prefill_json_start=True)',
      'prompt, used_template, diagnostics = module.build_prompt(FakeHarmonyTokenizer(), record, options)',
      'print(json.dumps({"promptTail": prompt[-80:], **diagnostics}))',
    ]);
    expect(parsed.promptTail).toContain('<|channel|>final<|message|>');
    expect(parsed.promptTail.endsWith('{')).toBe(false);
    expect(parsed.jsonPrefillApplied).toBe(false);
    expect(parsed.jsonPrefillSkippedReason).toBe('non_json_record');
  });

  it('fails closed when final-channel boundary derivation is unavailable', () => {
    const parsed = runPythonSnippet([
      'class NoTemplateTokenizer:',
      '    chat_template = None',
      '    def __call__(self, text, add_special_tokens=False, **kwargs):',
      '        return {"input_ids": [ord(char) for char in text]}',
      'record = {"id":"missing-template","prompt":"Return JSON.","expected":{"json_object":True}}',
      'options = argparse.Namespace(force_final_channel=True, prefill_json_start=False)',
      'try:',
      '    module.build_prompt(NoTemplateTokenizer(), record, options)',
      '    print(json.dumps({"raised": False}))',
      'except RuntimeError as error:',
      '    print(json.dumps({"raised": True, "message": str(error)}))',
    ]);
    expect(parsed.raised).toBe(true);
    expect(parsed.message).toContain('final-channel boundary derivation failed');
  });

  it('keeps JSON scoring strict after final extraction', () => {
    const failures = runEvaluation(
      {
        id: 'json-strict',
        expected: {
          json_object: true,
          must_include: ['allowed'],
        },
      },
      'The user wants JSON but no object follows.',
    );
    expect(failures).toContain('invalid_json');
    expect(failures).toContain('missing:allowed');
  });

  it('reports JSON diagnostic failure for invalid JSON and missing required fields', () => {
    const parsed = runPythonSnippet([
      'record = {"id":"json-diagnostics","expected":{"json_object":True,"required_json_fields":["allowedForTraining"],"must_include":["validate_dataset"]}}',
      'invalid = module.inspect_json_result("not json", record)',
      'missing = module.inspect_json_result("{\\"action\\":\\"other\\"}", record)',
      'failures = module.evaluate_output(record, "{\\"action\\":\\"validate_dataset\\"}")',
      'print(json.dumps({"invalid": invalid, "missing": missing, "failures": failures}))',
    ]);
    expect(parsed.invalid.validJson).toBe(false);
    expect(parsed.invalid.jsonParseError).toBeTruthy();
    expect(parsed.invalid.requiredJsonFieldsPresent).toBe(false);
    expect(parsed.missing.validJson).toBe(true);
    expect(parsed.missing.requiredJsonFieldsPresent).toBe(false);
    expect(parsed.failures).toContain('missing_json_field:allowedForTraining');
  });

  it('keeps unsafe control-plane boundary scoring strict', () => {
    const failures = runEvaluation(
      {
        id: 'boundary-strict',
        expected: {
          plane: 'control-plane',
          must_include: ['control'],
          must_not_include: ['writing pipeline should execute'],
        },
      },
      'writing pipeline should execute',
    );
    expect(failures).toContain('plane_mismatch');
    expect(failures).toContain('missing:control');
    expect(failures).toContain('forbidden:writing pipeline should execute');
  });

  it('rejects reports outside local_artifacts', () => {
    const fixture = makeAdapter();
    try {
      writeAdapterFixture(fixture.adapterDir, fixture.metadata);
      const result = runPython(['--dry-run', '--adapter-dir', fixture.adapterDir, '--eval-file', evalFile, '--output', join(fixture.tempDir, 'report.json')]);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(2);
      expect(parsed.message).toContain('local_artifacts');
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });
});
