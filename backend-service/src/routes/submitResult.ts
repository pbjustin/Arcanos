import { Router } from "express";

export const submitResultRouter = Router();

submitResultRouter.post("/", (req, res) => {
  console.log("Task result:", req.body);
  res.json({ acknowledged: true });
});
