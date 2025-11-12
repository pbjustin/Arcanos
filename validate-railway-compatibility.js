#!/usr/bin/env node
/**
 * Simple Railway deployment validator for ARCANOS
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';

console.log('🚄 Railway Compatibility Validator\n');

let passed = true;
function check(desc, condition) {
  console.log(`${condition ? '✅' : '❌'} ${desc}`);
  if (!condition) passed = false;
}

// Environment variables sourced from configuration files
const requiredEnv = ['OPENAI_API_KEY', 'PORT', 'RAILWAY_ENVIRONMENT', 'RAILWAY_API_TOKEN'];
const documentedEnv = new Set();

const envExamplePath = path.join(process.cwd(), '.env.example');
if (existsSync(envExamplePath)) {
  const envContent = readFileSync(envExamplePath, 'utf8');
  const matches = envContent.matchAll(/^([A-Z0-9_]+)=/gm);
  for (const match of matches) {
    documentedEnv.add(match[1]);
  }
  check('.env.example present', true);
} else {
  check('.env.example present', false);
}

let railwayConfig;
let railwayConfigPath;

const candidateConfigs = [
  path.join(process.cwd(), 'railway', 'config.example.json'),
  path.join(process.cwd(), 'railway.json'),
];

for (const candidate of candidateConfigs) {
  if (existsSync(candidate)) {
    try {
      railwayConfig = JSON.parse(readFileSync(candidate, 'utf8'));
      railwayConfigPath = candidate;
      break;
    } catch {
      // Continue searching for a parsable config
    }
  }
}

let startCommandDefined = false;
let portBound = false;

if (railwayConfig) {
  const collectEnv = (envObject = {}) => {
    for (const key of Object.keys(envObject)) {
      documentedEnv.add(key);
      if (envObject[key] && typeof envObject[key] === 'object') {
        const nestedKeys = Object.keys(envObject[key]);
        nestedKeys.forEach((nestedKey) => documentedEnv.add(nestedKey));
      }
    }
  };

  if (railwayConfig.deploy?.startCommand) {
    startCommandDefined = true;
  }

  if (railwayConfig.deploy?.env) {
    collectEnv(railwayConfig.deploy.env);
    if (railwayConfig.deploy.env.PORT) {
      portBound = true;
    }
  }

  if (railwayConfig.environments) {
    for (const env of Object.values(railwayConfig.environments)) {
      if (env?.variables) {
        collectEnv(env.variables);
        if (env.variables.PORT) {
          portBound = true;
        }
      }
    }
  }

  if (Array.isArray(railwayConfig.services)) {
    for (const service of railwayConfig.services) {
      if (service.startCommand || service.deploy?.startCommand) {
        startCommandDefined = true;
      }
      const serviceEnv = {
        ...(service.env || {}),
        ...(service.deploy?.env || {}),
      };
      collectEnv(serviceEnv);
      if (serviceEnv.PORT) {
        portBound = true;
      }
    }
  }

  check(`railway configuration loaded (${path.basename(railwayConfigPath)})`, true);
} else {
  check('railway configuration present', false);
}

for (const name of requiredEnv) {
  const documented = documentedEnv.has(name) || Boolean(process.env[name]);
  check(`env.${name} documented`, documented);
}

if (railwayConfig) {
  check('railway config defines start command', startCommandDefined);
  check('railway config binds PORT', portBound);
}

if (passed) {
  console.log('\n✅ Railway compatibility validation passed');
  process.exit(0);
} else {
  console.log('\n❌ Railway compatibility validation failed');
  process.exit(1);
}

