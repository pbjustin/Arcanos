import express from "express";
import ingestRoute from "./routes/ingest.js";
import queryRoute from "./routes/query.js";
import { PORT } from "./config.js";

const app = express();

app.use(express.json());
app.use("/api/ingest", ingestRoute);
app.use("/api/query", queryRoute);
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`✅ RAG backend running on port ${PORT}`));

export default app;
