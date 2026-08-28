import { Router, type Request, type Response } from "express";
import { getUserByApiKey } from "../services/supabase.js";
import {
  buildDiscoveryPayload,
  storeProposals,
  ProposalSubmissionSchema,
} from "../services/subscriptionDiscovery.js";

const router = Router();

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

const windowParam = (v: unknown) =>
  typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 24;

router.get("/discovery-payload", async (req: Request, res: Response) => {
  const user = await authenticate(req, res);
  if (!user) return;
  try {
    const payload = await buildDiscoveryPayload(user.id, windowParam(req.query.window));
    res.json({ success: true, payload });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

router.post("/proposals", async (req: Request, res: Response) => {
  const user = await authenticate(req, res);
  if (!user) return;

  const parsed = ProposalSubmissionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid submission", details: parsed.error.errors });
    return;
  }

  try {
    const result = await storeProposals(user.id, windowParam(req.body?.window), parsed.data);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
