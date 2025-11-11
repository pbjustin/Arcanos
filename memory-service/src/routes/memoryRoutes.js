import express from "express";
import auth from "../middleware/auth.js";
import audit from "../middleware/audit.js";
import resilience from "../middleware/resilience.js";
import { commitMemory, retrieveMemory } from "../controllers/memoryController.js";

const router = express.Router();

router.post("/commit", auth, resilience, audit, commitMemory);
router.get("/retrieve/:traceId", auth, resilience, audit, retrieveMemory);

export default router;
