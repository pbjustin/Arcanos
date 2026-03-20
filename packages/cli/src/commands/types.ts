import type { ProtocolCommandId, ProtocolRequest, ProtocolResponse } from "@arcanos/protocol";

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

export interface CliProtocolCommandResult<TData = unknown> {
  command: ProtocolCommandId;
  request: ProtocolRequest<unknown>;
  response: ProtocolResponse<TData>;
  humanOutput: string;
  extraJson?: Record<string, unknown>;
}
