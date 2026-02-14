import { Router } from "express";
import { handleUpload } from "../services/uploadService.js";

const router = Router();

router.post("/", async (req, res, next) => {
  try {
    const result = await handleUpload(req);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
