export interface Task {
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
}
