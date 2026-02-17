export interface Agent {
  agentId: string;
  version: string;
  lastHeartbeat: string;
  state: string;
  health: number;
}
