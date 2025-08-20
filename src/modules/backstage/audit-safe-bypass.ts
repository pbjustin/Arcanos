import fs from 'fs';
import path from 'path';

interface Roster {
  id: string;
  name: string;
  role: string;
}

interface Storyline {
  id: string;
  characters: unknown[];
  arc: string;
  result: string;
}

interface Reflection {
  storyId: string;
  notes: string;
}

function validateRoster(roster: any): roster is Roster {
  return (
    !!roster &&
    typeof roster.id === 'string' &&
    typeof roster.name === 'string' &&
    typeof roster.role === 'string'
  );
}

function validateStoryline(storyline: any): storyline is Storyline {
  return (
    !!storyline &&
    typeof storyline.id === 'string' &&
    Array.isArray(storyline.characters) &&
    typeof storyline.arc === 'string' &&
    typeof storyline.result === 'string'
  );
}

function validateReflection(reflection: any): reflection is Reflection {
  return (
    !!reflection &&
    typeof reflection.storyId === 'string' &&
    typeof reflection.notes === 'string'
  );
}

interface ValidatedData<T> {
  status: 'PASSED_SCHEMA_VALIDATION';
  type: BypassType;
  data: T;
  timestamp: number;
}

type BypassType = 'roster' | 'storyline' | 'reflection';

type BypassInput = Roster | Storyline | Reflection;

function backstageAuditBypass<T extends BypassInput>(
  data: T,
  type: BypassType
): ValidatedData<T> {
  let valid = false;

  switch (type) {
    case 'roster':
      valid = validateRoster(data);
      break;
    case 'storyline':
      valid = validateStoryline(data);
      break;
    case 'reflection':
      valid = validateReflection(data);
      break;
    default:
      throw new Error(`Unknown BackstageBooker data type: ${type}`);
  }

  if (!valid) {
    throw new Error(`BackstageBooker ${type} failed validation.`);
  }

  return {
    status: 'PASSED_SCHEMA_VALIDATION',
    type,
    data,
    timestamp: Date.now()
  };
}

const SAVE_PATH = path.join(process.cwd(), 'backstage_saves.json');

function safeSave(dataObj: ValidatedData<BypassInput>): boolean {
  try {
    let saves: any[] = [];
    if (fs.existsSync(SAVE_PATH)) {
      saves = JSON.parse(fs.readFileSync(SAVE_PATH, 'utf-8'));
    }
    saves.push(dataObj);

    fs.writeFileSync(SAVE_PATH, JSON.stringify(saves, null, 2));
    console.log(`\u2705 BackstageBooker ${dataObj.type} saved successfully.`);
    return true;
  } catch (err: any) {
    console.error('\u274c Save failed — triggering rollback + audit:', err.message);
    runRollback(dataObj);
    return false;
  }
}

function runRollback(failedData: ValidatedData<BypassInput>): void {
  const auditLog = path.join(process.cwd(), 'backstage_audit.log');
  const entry = {
    event: 'ROLLBACK_TRIGGERED',
    failedData,
    timestamp: Date.now()
  };
  fs.appendFileSync(auditLog, JSON.stringify(entry) + '\n');
  console.log('\uD83D\uDD04 Rollback logged:', entry);
}

export function saveBackstageEntry(
  data: BypassInput,
  type: BypassType
): boolean {
  const validated = backstageAuditBypass(data, type);
  return safeSave(validated);
}

export default saveBackstageEntry;
