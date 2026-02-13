import { Router } from "express";

const router = Router();

router.get("/", (_, res) => {
  res.json({ status: "healthy" });
});

export default router;
