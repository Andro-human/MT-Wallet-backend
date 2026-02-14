import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import smsRoutes from "./routes/sms.js";
import importRoutes from "./routes/import.js";

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Request logging in development
if (env.isDev) {
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// Routes
app.use("/api/sms", smsRoutes);
app.use("/api/import", importRoutes);

// Root health check
app.get("/", (_req, res) => {
  res.json({
    name: "MTWallet Backend",
    version: "1.0.0",
    status: "running",
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
      error: "Internal server error",
      message: env.isDev ? err.message : undefined,
    });
  }
);

// Start server
app.listen(env.port, () => {
  console.log(`
╔════════════════════════════════════════════╗
║          MTWallet Backend                  ║
╠════════════════════════════════════════════╣
║  Port: ${env.port}                              ║
║  Environment: ${env.nodeEnv.padEnd(24)}  ║
╚════════════════════════════════════════════╝
  `);
});
