import fs from 'fs';
import path from 'path';
import { describe, expect, it } from '@jest/globals';

const workspaceRoot = 'C:/pbjustin/Arcanos';
const protectedFiles = [
  'src/services/agentCapabilityRegistry.ts',
  'src/services/agentGoalPlanner.ts',
  'src/services/agentExecutionService.ts',
  'src/services/agentExecutionTraceService.ts',
  'src/routes/api-agent.ts'
];

const forbiddenPatterns = [
  /@core\/db/,
  /\.\.\/core\/db/,
  /logExecution/,
  /createCentralizedCompletion/,
  /generateMockResponse/,
  /hasValidAPIKey/,
  /from ['"].*openai\.js['"]/,
  /\bquery\(/,
  /\btransaction\(/,
  /\bfetch\(/,
  /DatabaseBackedDagJobQueue/
];

describe('agent boundary architecture', () => {
  it('prevents planner and agent-layer files from importing infrastructure directly', () => {
    for (const relativeFilePath of protectedFiles) {
      const absoluteFilePath = path.join(workspaceRoot, relativeFilePath);
      const fileContents = fs.readFileSync(absoluteFilePath, 'utf8');

      for (const forbiddenPattern of forbiddenPatterns) {
        //audit Assumption: the planner/capability layer must remain infrastructure-blind to preserve the CEF boundary; failure risk: future edits reintroduce direct DB, queue, or external-API access outside the CEF; expected invariant: protected files contain no forbidden infrastructure tokens; handling strategy: fail the architecture test on the first forbidden match.
        expect(fileContents).not.toMatch(forbiddenPattern);
      }
    }
  });
});
