import { Agent } from "../types/agent.js";
import { Task } from "../types/task.js";

export const agents = new Map<string, Agent>();
export const tasks: Task[] = [];
