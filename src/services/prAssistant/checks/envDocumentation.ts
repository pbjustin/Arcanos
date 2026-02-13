import fs from 'fs/promises';
import path from 'path';
import type { CheckContext } from "@services/prAssistant/types.js";

export async function validateEnvDocumentation(
  context: CheckContext,
  envVars: string[]
): Promise<{ issues: string[]; details: string[]; }> {
  const issues: string[] = [];
  const details: string[] = [];

  if (envVars.length === 0) {
    return { issues, details };
  }

  try {
    const envExamplePath = path.join(context.workingDir, '.env.example');
    const envExampleContent = await fs.readFile(envExamplePath, 'utf-8');

    const missingVars = envVars.filter(envVar => {
      const varName = envVar.replace('process.env.', '');
      return !envExampleContent.includes(varName);
    });

    if (missingVars.length > 0) {
      issues.push('New environment variables not documented');
      details.push('Update .env.example with new environment variables');
    }
  } catch {
    details.push('Consider creating .env.example for environment documentation');
  }

  return { issues, details };
}
