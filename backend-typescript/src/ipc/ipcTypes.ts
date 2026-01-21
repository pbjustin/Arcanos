/**
 * IPC message types and helpers.
 */

export type IpcMessage =
  | IpcHelloMessage
  | IpcHelloAckMessage
  | IpcHeartbeatMessage
  | IpcEventMessage
  | IpcCommandMessage
  | IpcCommandResultMessage
  | IpcErrorMessage;

export interface IpcHelloMessage {
  type: 'hello';
  clientId: string;
  sentAt: string;
  version?: string;
  capabilities?: string[];
  platform?: string;
  instanceId?: string;
}

export interface IpcHelloAckMessage {
  type: 'hello_ack';
  connectionId: string;
  serverTime: string;
  serverVersion?: string;
}

export interface IpcHeartbeatMessage {
  type: 'heartbeat';
  sentAt: string;
  status?: string;
}

export interface IpcEventMessage {
  type: 'event';
  eventType: string;
  eventId: string;
  sentAt: string;
  payload: Record<string, unknown>;
  source?: string;
}

export interface IpcCommandMessage {
  type: 'command';
  commandId: string;
  name: string;
  issuedAt: string;
  payload?: Record<string, unknown>;
}

export interface IpcCommandResultMessage {
  type: 'command_result';
  commandId: string;
  ok: boolean;
  respondedAt: string;
  payload?: Record<string, unknown>;
  error?: string;
}

export interface IpcErrorMessage {
  type: 'error';
  message: string;
  sentAt: string;
  code?: string;
  details?: string;
}

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  //audit assumption: IPC payloads are JSON objects; risk: invalid message; invariant: plain object; strategy: type guard.
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    //audit assumption: payload optional; risk: invalid payload; invariant: object when present; strategy: ignore invalid payload.
    return undefined;
  }
  return value;
}

/**
 * Parse raw IPC JSON into a typed message.
 * Inputs/Outputs: unknown input; returns ParseResult with IpcMessage or error.
 * Edge cases: unknown message types return ok=false with error.
 */
export function parseIpcMessage(raw: unknown): ParseResult<IpcMessage> {
  if (!isPlainObject(raw)) {
    //audit assumption: payload must be object; risk: invalid JSON; invariant: object required; strategy: return error.
    return { ok: false, error: 'IPC payload must be an object' };
  }

  const type = raw.type;
  if (!isNonEmptyString(type)) {
    //audit assumption: type is required; risk: missing type; invariant: type string; strategy: return error.
    return { ok: false, error: 'IPC payload missing type' };
  }

  if (type === 'hello') {
    if (!isNonEmptyString(raw.clientId) || !isNonEmptyString(raw.sentAt)) {
      //audit assumption: hello requires clientId/sentAt; risk: incomplete handshake; invariant: required fields; strategy: error.
      return { ok: false, error: 'IPC hello missing clientId or sentAt' };
    }
    return {
      ok: true,
      value: {
        type,
        clientId: raw.clientId.trim(),
        sentAt: raw.sentAt.trim(),
        version: isNonEmptyString(raw.version) ? raw.version.trim() : undefined,
        capabilities: Array.isArray(raw.capabilities)
          ? raw.capabilities.filter((entry) => typeof entry === 'string')
          : undefined,
        platform: isNonEmptyString(raw.platform) ? raw.platform.trim() : undefined,
        instanceId: isNonEmptyString(raw.instanceId) ? raw.instanceId.trim() : undefined
      }
    };
  }

  if (type === 'heartbeat') {
    if (!isNonEmptyString(raw.sentAt)) {
      //audit assumption: heartbeat requires sentAt; risk: stale connection; invariant: sentAt present; strategy: error.
      return { ok: false, error: 'IPC heartbeat missing sentAt' };
    }
    return {
      ok: true,
      value: {
        type,
        sentAt: raw.sentAt.trim(),
        status: isNonEmptyString(raw.status) ? raw.status.trim() : undefined
      }
    };
  }

  if (type === 'event') {
    if (!isNonEmptyString(raw.eventType) || !isNonEmptyString(raw.eventId) || !isNonEmptyString(raw.sentAt)) {
      //audit assumption: event requires identifiers; risk: loss of audit; invariant: required fields; strategy: error.
      return { ok: false, error: 'IPC event missing eventType, eventId, or sentAt' };
    }
    const payload = normalizeRecord(raw.payload);
    if (!payload) {
      //audit assumption: payload required; risk: incomplete event; invariant: payload object; strategy: error.
      return { ok: false, error: 'IPC event payload must be an object' };
    }
    return {
      ok: true,
      value: {
        type,
        eventType: raw.eventType.trim(),
        eventId: raw.eventId.trim(),
        sentAt: raw.sentAt.trim(),
        payload,
        source: isNonEmptyString(raw.source) ? raw.source.trim() : undefined
      }
    };
  }

  if (type === 'command_result') {
    if (!isNonEmptyString(raw.commandId) || !isNonEmptyString(raw.respondedAt) || typeof raw.ok !== 'boolean') {
      //audit assumption: command_result requires commandId/ok/respondedAt; risk: missing status; invariant: required fields; strategy: error.
      return { ok: false, error: 'IPC command_result missing required fields' };
    }
    return {
      ok: true,
      value: {
        type,
        commandId: raw.commandId.trim(),
        ok: raw.ok,
        respondedAt: raw.respondedAt.trim(),
        payload: normalizeRecord(raw.payload),
        error: isNonEmptyString(raw.error) ? raw.error.trim() : undefined
      }
    };
  }

  if (type === 'command') {
    if (!isNonEmptyString(raw.commandId) || !isNonEmptyString(raw.name) || !isNonEmptyString(raw.issuedAt)) {
      //audit assumption: command requires identifiers; risk: invalid command; invariant: required fields; strategy: error.
      return { ok: false, error: 'IPC command missing required fields' };
    }
    return {
      ok: true,
      value: {
        type,
        commandId: raw.commandId.trim(),
        name: raw.name.trim(),
        issuedAt: raw.issuedAt.trim(),
        payload: normalizeRecord(raw.payload)
      }
    };
  }

  if (type === 'error') {
    if (!isNonEmptyString(raw.message) || !isNonEmptyString(raw.sentAt)) {
      //audit assumption: error message required; risk: opaque errors; invariant: message present; strategy: error.
      return { ok: false, error: 'IPC error missing message or sentAt' };
    }
    return {
      ok: true,
      value: {
        type,
        message: raw.message.trim(),
        sentAt: raw.sentAt.trim(),
        code: isNonEmptyString(raw.code) ? raw.code.trim() : undefined,
        details: isNonEmptyString(raw.details) ? raw.details.trim() : undefined
      }
    };
  }

  //audit assumption: unsupported message types are rejected; risk: ignored payloads; invariant: known types only; strategy: error.
  return { ok: false, error: `Unsupported IPC message type: ${type}` };
}

/**
 * Build a hello_ack message for the daemon.
 * Inputs/Outputs: connectionId and serverTime; returns IpcHelloAckMessage.
 * Edge cases: serverVersion omitted when empty.
 */
export function buildHelloAckMessage(
  connectionId: string,
  serverTime: string,
  serverVersion?: string
): IpcHelloAckMessage {
  return {
    type: 'hello_ack',
    connectionId,
    serverTime,
    serverVersion: serverVersion?.trim() || undefined
  };
}

/**
 * Build a command message for the daemon.
 * Inputs/Outputs: commandId, name, issuedAt, optional payload; returns IpcCommandMessage.
 * Edge cases: payload omitted when empty.
 */
export function buildCommandMessage(
  commandId: string,
  name: string,
  issuedAt: string,
  payload?: Record<string, unknown>
): IpcCommandMessage {
  return {
    type: 'command',
    commandId,
    name,
    issuedAt,
    payload: payload && Object.keys(payload).length ? payload : undefined
  };
}

/**
 * Build a structured error message.
 * Inputs/Outputs: message text and timestamp; returns IpcErrorMessage.
 * Edge cases: code/details omitted when empty.
 */
export function buildErrorMessage(
  message: string,
  sentAt: string,
  code?: string,
  details?: string
): IpcErrorMessage {
  return {
    type: 'error',
    message,
    sentAt,
    code: code?.trim() || undefined,
    details: details?.trim() || undefined
  };
}
