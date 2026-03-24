import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findLayerAccessViolations,
  getProtectedLayerFiles,
  runCliCheck,
  scanFileForLayerAccessViolations
} from './check-cef-layer-access.js';

export {
  findLayerAccessViolations,
  getProtectedLayerFiles,
  scanFileForLayerAccessViolations
};

const currentScriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentScriptPath)) {
  runCliCheck();
}
