import type { ProtocolRequest, ProtocolResponse } from "@arcanos/protocol";

export interface CliGlobalOptions {
  json: boolean;
  baseUrl: string;
  sessionId?: string;
  projectId?: string;
  environment?: string;
  cwd?: string;
  shell?: string;
  pythonBinary?: string;
  transport: "python" | "local";
}

export interface AskCommandInvocation {
  kind: "ask";
  prompt: string;
  options: CliGlobalOptions;
}

export interface PlanCommandInvocation {
  kind: "plan";
  prompt: string;
  options: CliGlobalOptions;
}

export interface ExecCommandInvocation {
  kind: "exec";
  prompt?: string;
  options: CliGlobalOptions;
}

export interface StatusCommandInvocation {
  kind: "status";
  options: CliGlobalOptions;
}

export interface WorkersCommandInvocation {
  kind: "workers";
  options: CliGlobalOptions;
}

export interface LogsCommandInvocation {
  kind: "logs";
  recent: boolean;
  options: CliGlobalOptions;
}

export interface InspectCommandInvocation {
  kind: "inspect";
  subject: "self-heal";
  options: CliGlobalOptions;
}

export interface DoctorCommandInvocation {
  kind: "doctor";
  subject: "implementation";
  options: CliGlobalOptions;
}

export interface ProtocolCommandInvocation {
  kind: "protocol";
  argv: string[];
}

export interface HelpCommandInvocation {
  kind: "help";
}

export type CliInvocation =
  | AskCommandInvocation
  | PlanCommandInvocation
  | ExecCommandInvocation
  | StatusCommandInvocation
  | WorkersCommandInvocation
  | LogsCommandInvocation
  | InspectCommandInvocation
  | DoctorCommandInvocation
  | ProtocolCommandInvocation
  | HelpCommandInvocation;

export interface CliSuccessEnvelope<TData> {
  ok: boolean;
  data: TData;
}

export interface CliFailureEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type CliJsonEnvelope<TData> = CliSuccessEnvelope<TData> | CliFailureEnvelope;

export interface CliCommandResult<TData = unknown> {
  command: string;
  request: ProtocolRequest<unknown> | Record<string, unknown>;
  response: ProtocolResponse<TData> | {
    ok: boolean;
    data?: TData;
    error?: {
      code: string;
      message: string;
    };
    meta?: Record<string, unknown>;
  };
  humanOutput: string;
  extraJson?: Record<string, unknown>;
}

export type CliProtocolCommandResult<TData = unknown> = CliCommandResult<TData>;
