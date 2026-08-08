import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export function resolvePromptsConfigSearchPaths(
  cwd: string = process.cwd()
): readonly string[] {
  return [
    join(cwd, 'config', 'prompts.json'),
    join(RUNTIME_DIRECTORY, 'prompts.json'),
    join(RUNTIME_DIRECTORY, '..', '..', 'config', 'prompts.json'),
    join(RUNTIME_DIRECTORY, '..', '..', '..', 'config', 'prompts.json'),
    join(cwd, 'src', 'config', 'prompts.json')
  ];
}

export function resolveFallbackMessagesSearchPaths(
  cwd: string = process.cwd()
): readonly string[] {
  return [
    join(cwd, 'config', 'fallbackMessages.json'),
    join(RUNTIME_DIRECTORY, 'fallbackMessages.json'),
    join(cwd, 'src', 'config', 'fallbackMessages.json')
  ];
}

export function resolveAssistantRegistryPath(
  setting: string | undefined,
  cwd: string = process.cwd()
): string {
  return setting || join(cwd, 'config', 'assistants.json');
}

export function resolveDaemonTokensFilePath(
  setting: string | undefined,
  cwd: string = process.cwd()
): string {
  if (!setting) {
    return join(cwd, 'memory', 'daemon_tokens.json');
  }
  return isAbsolute(setting) ? setting : join(cwd, setting);
}
