import { Router, type Request, type Response } from "express";
import { getUserByApiKey } from "../services/supabase.js";
import { generateMonthlySummary, MonthlyAggregatesSchema } from "../services/monthlySummary.js";

const router = Router();

router.post("/monthly-summary", async (req: Request, res: Response) => {
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

  const parsed = MonthlyAggregatesSchema.safeParse(req.body?.aggregates);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid aggregates", details: parsed.error.errors });
    return;
  }

  try {
    const result = await generateMonthlySummary(user.id, parsed.data);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
