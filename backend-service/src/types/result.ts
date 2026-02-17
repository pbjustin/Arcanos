import { Task } from "./task.js";

export interface AssignedTask {
  task: Task;
  agentId: string;
  assignedAt: string;
}

export interface TaskResultRecord {
  taskId: string;
  agentId: string;
  result: Record<string, unknown>;
  submittedAt: string;
}
