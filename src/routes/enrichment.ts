import { Router, type Request, type Response } from "express";
import { getUserByApiKey } from "../services/supabase.js";
import { runEnrichmentPass } from "../services/enrichmentJob.js";

const router = Router();

// Manual trigger for the nightly enrichment pass (testing / catch-up).
router.post("/run", async (req: Request, res: Response) => {
  const raw = req.headers["x-api-key"];
  const apiKey = Array.isArray(raw) ? raw[0] : raw;
  if (!apiKey) {
    res.status(401).json({ success: false, error: "Missing x-api-key header" });
    return;
  }
  const user = await getUserByApiKey(apiKey);
  if (!user) {
    res.status(401).json({ success: false, error: "Invalid API key" });
    return;
  }

  try {
    const result = await runEnrichmentPass({
      limit: typeof req.body?.limit === "number" ? req.body.limit : undefined,
      maxRupees: typeof req.body?.max_rupees === "number" ? req.body.max_rupees : undefined,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
