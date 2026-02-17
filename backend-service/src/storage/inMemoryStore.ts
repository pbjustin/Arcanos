import { Agent } from "../types/agent.js";
import { AssignedTask, TaskResultRecord } from "../types/result.js";
import { Task } from "../types/task.js";

export const agents = new Map<string, Agent>();
export const tasks: Task[] = [];
export const assignedTasks = new Map<string, AssignedTask>();
export const taskResults: TaskResultRecord[] = [];
