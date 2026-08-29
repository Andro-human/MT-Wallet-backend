import { Router, type Request, type Response } from "express";
import { getUserByApiKey } from "../services/supabase.js";
import {
  buildReviewPayload,
  storeReview,
  currentIstMonth,
  ReviewSubmissionSchema,
  MONTH_RE,
} from "../services/monthlyReview.js";
import { findStaleMonths } from "../services/staleMonths.js";

const router = Router();

// Key via header normally; ?api_key= fallback for schedulers that can't set
// headers (the key then lands in request logs — acceptable for this app).
async function authenticate(req: Request, res: Response): Promise<{ id: string } | null> {
  const raw = req.headers["x-api-key"] ?? req.query.api_key;
  const apiKey = Array.isArray(raw) ? raw[0] : raw;
  if (!apiKey || typeof apiKey !== "string") {
    res.status(401).json({ success: false, error: "Missing x-api-key header or api_key query param" });
    return null;
  }
  const user = await getUserByApiKey(apiKey);
  if (!user) {
    res.status(401).json({ success: false, error: "Invalid API key" });
    return null;
  }
  return user as { id: string };
}

function monthParam(req: Request, res: Response): string | null {
  const month = (req.method === "GET" ? req.query.month : req.body?.month) ?? currentIstMonth();
  if (typeof month !== "string" || !MONTH_RE.test(month)) {
    res.status(400).json({ success: false, error: "month must be YYYY-MM" });
    return null;
  }
  return month;
}

router.get("/payload", async (req: Request, res: Response) => {
  const user = await authenticate(req, res);
  if (!user) return;
  const month = monthParam(req, res);
  if (!month) return;

  try {
    const payload = await buildReviewPayload(user.id, month);
    res.json({ success: true, payload });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

router.get("/stale", async (req: Request, res: Response) => {
  const user = await authenticate(req, res);
  if (!user) return;

  const num = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
  try {
    const report = await findStaleMonths(user.id, {
      windowMonths: num(req.query.window),
      limit: num(req.query.limit),
    });
    res.json({ success: true, ...report });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

router.post("/groupings", async (req: Request, res: Response) => {
  const user = await authenticate(req, res);
  if (!user) return;

  const parsed = ReviewSubmissionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "Invalid submission shape",
      details: parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
    });
    return;
  }

  try {
    // Reconcile against a FRESH payload so drift between GET and POST
    // (new txns, refund links) fails loudly instead of storing stale sums.
    const payload = await buildReviewPayload(user.id, parsed.data.month);
    const result = await storeReview(user.id, payload, parsed.data);
    if ("errors" in result) {
      res.status(422).json({
        success: false,
        error: "Reconciliation failed — fix the groupings and resubmit (re-fetch the payload if transactions changed)",
        details: result.errors,
      });
      return;
    }
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
