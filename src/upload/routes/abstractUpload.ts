import { Router } from "express";
import { routeAbstractUpload } from "../services/abstractionService.js";

const router = Router();

router.post("/", async (req, res, next) => {
  try {
    const result = await routeAbstractUpload(req.body);
    res.json({ status: "success", result });
  } catch (err) {
    next(err);
  }
});

export default router;
