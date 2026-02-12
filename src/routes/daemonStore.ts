import { randomUUID } from 'crypto';
import type fs from 'fs';
import type path from 'path';
import { logger } from "@platform/logging/structuredLogging.js";
import type {
  DaemonCommand,
  DaemonHeartbeat,
  DaemonStore,
  PendingDaemonAction,
  PendingDaemonActions
} from './daemonStore/types.js';

type DaemonLogger = Pick<typeof logger, 'info' | 'warn' | 'error'>;

type FileSystemDeps = Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'>;

type PathDeps = Pick<typeof path, 'dirname'>;

interface DaemonStoreDependencies {
  fs: FileSystemDeps;
  path: PathDeps;
  logger: DaemonLogger;
  tokensFilePath: string;
  now: () => Date;
}

function buildDaemonKey(token: string, instanceId: string): string {
  return `${token}:${instanceId}`;
}

function ensureTokensDirectoryExists(filePath: string, deps: DaemonStoreDependencies): void {
  const dir = deps.path.dirname(filePath);
  if (!deps.fs.existsSync(dir)) {
    //audit Assumption: directory may not exist; risk: write failure; invariant: directory created; handling: mkdir recursive.
    deps.fs.mkdirSync(dir, { recursive: true });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Purpose: Create an in-memory daemon store with persistence helpers.
 * Inputs/Outputs: dependencies for FS, path, logging, and clock; returns store API.
 * Edge cases: persistence failures are logged and do not throw.
 */
export function createDaemonStore(deps: DaemonStoreDependencies): DaemonStore {
  const daemonHeartbeats = new Map<string, DaemonHeartbeat>();
  const daemonCommands = new Map<string, DaemonCommand[]>();
  const daemonTokensByInstanceId = new Map<string, string>();
  const pendingDaemonActions = new Map<string, PendingDaemonActions>();

  const loadTokens = (): void => {
    if (!deps.fs.existsSync(deps.tokensFilePath)) {
      //audit Assumption: missing file is expected; risk: no tokens loaded; invariant: skip load; handling: return.
      deps.logger.info('Daemon token file not found; starting with empty mappings', {
        module: 'daemonStore.loadTokens',
        tokensFilePath: deps.tokensFilePath
      });
      return;
    }

    try {
      const raw = deps.fs.readFileSync(deps.tokensFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        //audit Assumption: tokens file should be JSON object; risk: corrupt data; invariant: ignore invalid; handling: warn + return.
        deps.logger.warn('Daemon token file malformed; ignoring contents', {
          module: 'daemonStore.loadTokens',
          tokensFilePath: deps.tokensFilePath
        });
        return;
      }

      for (const [instanceId, token] of Object.entries(parsed)) {
        if (typeof token === 'string') {
          //audit Assumption: token values should be strings; risk: invalid entry; invariant: store valid tokens; handling: set mapping.
          daemonTokensByInstanceId.set(instanceId, token);
        } else {
          //audit Assumption: non-string token should be ignored; risk: unusable data; invariant: skip invalid; handling: warn.
          deps.logger.warn('Skipping invalid daemon token entry', {
            module: 'daemonStore.loadTokens',
            instanceId
          });
        }
      }

      deps.logger.info('Loaded daemon token mappings', {
        module: 'daemonStore.loadTokens',
        count: daemonTokensByInstanceId.size
      });
    } catch (error) {
      //audit Assumption: read/parse can fail; risk: tokens unavailable; invariant: errors logged; handling: log and continue.
      deps.logger.error('Failed to load daemon tokens', {
        module: 'daemonStore.loadTokens',
        tokensFilePath: deps.tokensFilePath
      }, undefined, error instanceof Error ? error : undefined);
    }
  };

  const saveTokens = (): void => {
    try {
      const tokensSnapshot: Record<string, string> = {};
      for (const [instanceId, token] of daemonTokensByInstanceId.entries()) {
        //audit Assumption: token map is authoritative; risk: stale data; invariant: snapshot mirrors map; handling: copy entries.
        tokensSnapshot[instanceId] = token;
      }

      ensureTokensDirectoryExists(deps.tokensFilePath, deps);
      deps.fs.writeFileSync(deps.tokensFilePath, JSON.stringify(tokensSnapshot, null, 2), 'utf-8');
      deps.logger.info('Saved daemon token mappings', {
        module: 'daemonStore.saveTokens',
        count: daemonTokensByInstanceId.size
      });
    } catch (error) {
      //audit Assumption: write failures should not crash; risk: tokens not persisted; invariant: error logged; handling: swallow.
      deps.logger.error('Failed to save daemon tokens', {
        module: 'daemonStore.saveTokens',
        tokensFilePath: deps.tokensFilePath
      }, undefined, error instanceof Error ? error : undefined);
    }
  };

  const getTokenForInstance = (instanceId: string): string | null => {
    const token = daemonTokensByInstanceId.get(instanceId);
    if (!token) {
      //audit Assumption: missing token means unlinked instance; risk: queue failures; invariant: null returned; handling: return null.
      return null;
    }
    return token;
  };

  const setTokenForInstance = (instanceId: string, token: string): void => {
    daemonTokensByInstanceId.set(instanceId, token);
  };

  const recordHeartbeat = (token: string, heartbeat: DaemonHeartbeat): void => {
    const key = buildDaemonKey(token, heartbeat.instanceId);
    daemonHeartbeats.set(key, heartbeat);
  };

  const getHeartbeat = (token: string, instanceId: string): DaemonHeartbeat | undefined => {
    const key = buildDaemonKey(token, instanceId);
    return daemonHeartbeats.get(key);
  };

  const listPendingCommands = (token: string, instanceId: string): DaemonCommand[] => {
    const key = buildDaemonKey(token, instanceId);
    const commands = daemonCommands.get(key) || [];
    //audit Assumption: pending commands are unacknowledged; risk: stale commands; invariant: filter list; handling: filter by flag.
    return commands.filter(command => !command.acknowledged);
  };

  const acknowledgeCommands = (
    token: string,
    instanceId: string,
    commandIds: string[],
    retentionWindowMs: number
  ): number => {
    const key = buildDaemonKey(token, instanceId);
    const commands = daemonCommands.get(key) || [];
    let acknowledgedCount = 0;

    //audit Assumption: command IDs map improves lookup performance; risk: map mismatch; invariant: map mirrors commands list; handling: build map.
    const commandMap = new Map(commands.map(command => [command.id, command]));
    for (const commandId of commandIds) {
      const command = commandMap.get(commandId);
      if (command && !command.acknowledged) {
        //audit Assumption: command exists and not yet acknowledged; risk: double ack; invariant: mark once; handling: update flag.
        command.acknowledged = true;
        acknowledgedCount += 1;
      }
    }

    const cutoff = deps.now().getTime() - retentionWindowMs;
    const filteredCommands = commands.filter(command => {
      const isRecent = command.issuedAt.getTime() > cutoff;
      //audit Assumption: recent commands should be retained; risk: removing active commands; invariant: keep recent or unacked; handling: filter.
      return !command.acknowledged || isRecent;
    });

    daemonCommands.set(key, filteredCommands);
    return acknowledgedCount;
  };

  const queueCommand = (
    token: string,
    instanceId: string,
    name: string,
    payload: Record<string, unknown>
  ): string => {
    const key = buildDaemonKey(token, instanceId);
    const commands = daemonCommands.get(key) || [];
    const commandId = randomUUID();

    const command: DaemonCommand = {
      id: commandId,
      instanceId,
      name,
      payload,
      issuedAt: deps.now(),
      acknowledged: false
    };

    commands.push(command);
    daemonCommands.set(key, commands);

    return commandId;
  };

  const queueCommandForInstance = (
    instanceId: string,
    name: string,
    payload: Record<string, unknown>
  ): string | null => {
    const token = getTokenForInstance(instanceId);
    if (!token) {
      //audit Assumption: token required to queue; risk: orphan command; invariant: null returned; handling: return null.
      return null;
    }
    return queueCommand(token, instanceId, name, payload);
  };

  const createPendingActions = (instanceId: string, actions: PendingDaemonAction[], ttlMs: number): string => {
    const id = randomUUID();
    const expiresAt = new Date(deps.now().getTime() + ttlMs);
    pendingDaemonActions.set(id, {
      id,
      instanceId,
      actions,
      expiresAt
    });
    return id;
  };

  const consumePendingActions = (
    confirmationToken: string,
    instanceId: string,
    daemonToken: string
  ): number => {
    const pending = pendingDaemonActions.get(confirmationToken);
    if (!pending) {
      //audit Assumption: missing token is invalid; risk: replay or mismatch; invariant: reject; handling: return -1.
      return -1;
    }

    const now = deps.now();
    if (pending.expiresAt.getTime() <= now.getTime()) {
      //audit Assumption: expired tokens must be rejected; risk: late execution; invariant: delete and reject; handling: cleanup.
      pendingDaemonActions.delete(confirmationToken);
      return -1;
    }

    if (pending.instanceId !== instanceId) {
      //audit Assumption: instance must match; risk: cross-instance execution; invariant: reject; handling: return -1.
      return -1;
    }

    const expectedToken = getTokenForInstance(instanceId);
    if (!expectedToken || expectedToken !== daemonToken) {
      //audit Assumption: daemon token must match; risk: unauthorized execution; invariant: reject; handling: return -1.
      return -1;
    }

    let queuedCount = 0;
    for (const action of pending.actions) {
      const commandId = queueCommandForInstance(instanceId, action.daemon, action.payload);
      // After validation above, commandId is guaranteed to be non-null
      if (commandId) {
        //audit Assumption: queue returns ID on success; risk: missing command; invariant: count successes; handling: increment.
        queuedCount += 1;
      }
    }

    pendingDaemonActions.delete(confirmationToken);
    return queuedCount;
  };

  return {
    loadTokens,
    saveTokens,
    getTokenForInstance,
    setTokenForInstance,
    recordHeartbeat,
    getHeartbeat,
    listPendingCommands,
    acknowledgeCommands,
    queueCommand,
    queueCommandForInstance,
    createPendingActions,
    consumePendingActions
  };
}

export type {
  DaemonCommand,
  DaemonHeartbeat,
  DaemonStore,
  PendingDaemonAction,
  PendingDaemonActions
};
