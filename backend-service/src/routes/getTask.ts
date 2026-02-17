import { Router } from "express";
import { tasks } from "../storage/inMemoryStore.js";

export const getTaskRouter = Router();

getTaskRouter.post("/", (req, res) => {
  if (tasks.length === 0) {
    return res.json({ task: null });
  }

  const task = tasks.shift();
  res.json({ task });
});
