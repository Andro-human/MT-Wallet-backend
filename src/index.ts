// ── Bootstrap ──────────────────────────────────────────────────────────────────
// In ESM, static `import` declarations are hoisted and execute BEFORE any other
// code in the module — even code that appears above them. This means if any
// imported module throws (e.g. env.ts on a missing env var), our process.on
// handlers and console.log calls would never run.
//
// To guarantee error handlers are registered FIRST, we use dynamic import().
// This file has ZERO static imports so nothing can throw before we're ready.

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION — process will exit:");
  console.error(err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION — process will exit:");
  console.error(reason);
  process.exit(1);
});

console.log("[startup] Process starting, registering crash handlers...");
console.log(`[startup] Node ${process.version}, platform: ${process.platform}, arch: ${process.arch}`);
console.log(`[startup] PORT env = ${process.env.PORT ?? "(not set)"}`);

async function main() {
  console.log("[startup] Loading modules...");

  const [
    { default: express },
    { default: cors },
    { env },
    { default: smsRoutes },
    { default: importRoutes },
    { default: syncRunsRoutes },
  ] = await Promise.all([
    import("express"),
    import("cors"),
    import("./config/env.js"),
    import("./routes/sms.js"),
    import("./routes/import.js"),
    import("./routes/sync-runs.js"),
  ]);

  console.log("[startup] All modules loaded successfully.");

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
  app.use("/api/sync-runs", syncRunsRoutes);

  // Root health check
  app.get("/", (_req, res) => {
    res.json({
      name: "MTWallet Backend",
      version: "1.0.0",
      status: "running",
      port: env.port,
    });
  });

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Error handler
  app.use(((err: Error, _req: import("express").Request, res: import("express").Response, _next: import("express").NextFunction) => {
    console.error("Unhandled error:", err);
    res.status(500).json({
      error: "Internal server error",
      message: env.isDev ? err.message : undefined,
    });
  }) as import("express").ErrorRequestHandler);

 
  const server = app.listen(env.port, () => {
    console.log(`[startup] Server listening on http://localhost:${env.port}`);
    console.log(`[startup] Environment: ${env.nodeEnv}`);
  });

  server.on("error", (err) => {
    console.error("Server failed to start:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("FATAL: Failed during app initialization:");
  console.error(err);
  process.exit(1);
});
