import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: Express = express();

const DEBUG = process.env["DEBUG"] === "true";

// Security headers
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload"
  );
  next();
});

// CORS - allow same-origin frontend
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

// Body parsing - support up to 4MB (encrypted payload overhead)
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true, limit: "4mb" }));

// Minimal request logging (debug mode only)
if (DEBUG) {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.info({ method: req.method, url: req.url?.split("?")[0] }, "request");
    next();
  });
}

app.use("/api", router);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "not_found", message: "Route not found" });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (DEBUG) {
    logger.error({ err }, "Unhandled error");
  }
  res.status(500).json({ error: "internal_error", message: "Internal server error" });
});

export default app;
