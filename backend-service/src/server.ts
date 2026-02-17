import express, { NextFunction, Request, Response } from "express";
import cors from "cors";

import { createCorsOptions } from "./config/cors.js";
import { registerRouter } from "./routes/register.js";
import { heartbeatRouter } from "./routes/heartbeat.js";
import { getTaskRouter } from "./routes/getTask.js";
import { submitResultRouter } from "./routes/submitResult.js";

const app = express();

app.use(cors(createCorsOptions()));
app.use(express.json());

app.use("/register-agent", registerRouter);
app.use("/heartbeat", heartbeatRouter);
app.use("/get-task", getTaskRouter);
app.use("/submit-result", submitResultRouter);
app.use((error: Error, _req: Request, res: Response, next: NextFunction) => {
  //audit assumption: CORS middleware surfaces policy failures as errors; return explicit 403.
  if (error.message === "Origin not allowed by CORS") {
    return res.status(403).json({ error: error.message });
  }
  return next(error);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
