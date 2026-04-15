import { Router, type IRouter, type Request, type Response } from "express";
import { getStats } from "../services/shareManager.js";
import crypto from "crypto";

const router: IRouter = Router();

// Generate health API key at startup
const healthApiKey = crypto.randomBytes(32).toString("hex");
console.log(`[VaultDrop] Health API key: ${healthApiKey}`);

router.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

router.get("/health", (req: Request, res: Response) => {
  const authHeader = req.headers["authorization"];
  const queryKey = req.query["key"];

  const provided =
    authHeader?.replace("Bearer ", "").trim() ??
    (typeof queryKey === "string" ? queryKey : undefined);

  if (provided !== healthApiKey) {
    res.status(401).json({
      error: "unauthorized",
      message: "Valid API key required",
    });
    return;
  }

  const stats = getStats();

  res.json({
    status: "healthy",
    containers_created: stats.containersCreated,
    containers_delivered: stats.containersDelivered,
    memory_used_mb: stats.memoryUsedMb,
    memory_free_mb: stats.memoryFreeMb,
    timestamp: new Date().toISOString(),
  });
});

export default router;
