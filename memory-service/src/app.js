import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import memoryRoutes from "./routes/memoryRoutes.js";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("combined"));

app.use("/api/memory", memoryRoutes);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

export default app;
