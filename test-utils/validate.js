import { execSync } from 'child_process';

export function validateSyntax(file) {
  try {
    execSync(`node --check ${file}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    console.error(`❌ Syntax error in ${file}:`, err.message);
    return false;
  }
}
