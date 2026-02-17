import express from "express";
import cors from "cors";

import { registerRouter } from "./routes/register.js";
import { heartbeatRouter } from "./routes/heartbeat.js";
import { getTaskRouter } from "./routes/getTask.js";
import { submitResultRouter } from "./routes/submitResult.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/register-agent", registerRouter);
app.use("/heartbeat", heartbeatRouter);
app.use("/get-task", getTaskRouter);
app.use("/submit-result", submitResultRouter);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
