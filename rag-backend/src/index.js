import express from "express";
import dotenv from "dotenv";
import ingestRoute from "./routes/ingest.js";
import queryRoute from "./routes/query.js";

dotenv.config();
const app = express();

app.use(express.json());
app.use("/api/ingest", ingestRoute);
app.use("/api/query", queryRoute);
app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ RAG backend running on port ${PORT}`));

export default app;
