import { Router, type Request, type Response } from "express";
import { getUserByApiKey } from "../services/supabase.js";
import { runEnrichmentPass, selectPendingEnrichment, noteHash } from "../services/enrichmentJob.js";
import { supabase } from "../services/supabase.js";
import {
  EnrichmentSubmissionSchema,
  verifyEnrichment,
} from "../services/enrichmentSubmit.js";

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

async function authed(req: Request, res: Response) {
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
  return user;
}

/** Transactions needing enrichment, for the nightly agent.
 *
 *  Same selection the Gemini pass used: a noted transaction with no enrichment
 *  row, or one whose note changed since (note_hash mismatch). The agent gets the
 *  note, merchant, amount and current category, plus the category vocabulary,
 *  which is everything the old prompt was given.
 */
router.get("/pending", async (req: Request, res: Response) => {
  const user = await authed(req, res);
  if (!user) return;

  const limit = Math.min(Number(req.query.limit ?? 300) || 300, 1000);
  try {
    const [pending, cats] = await Promise.all([
      selectPendingEnrichment(limit),
      supabase.from("categories").select("slug, name").or(`is_system.eq.true,user_id.eq.${user.id}`),
    ]);
    const mine = pending.filter((p) => p.user_id === user.id);
    res.json({
      success: true,
      known_category_slugs: (cats.data ?? []).map((c: { slug: string }) => c.slug).sort(),
      count: mine.length,
      transactions: mine.map((p) => ({
        id: p.id,
        note: p.notes,
        merchant: p.merchant,
        amount: p.amount,
        current_category: p.category,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** Store agent-proposed enrichment.
 *
 *  Partial on purpose: a bad category slug drops that one item and reports it,
 *  rather than discarding the whole batch. These are independent per-transaction
 *  labels, unlike the monthly review whose parts must reconcile with each other.
 */
router.post("/submit", async (req: Request, res: Response) => {
  const user = await authed(req, res);
  if (!user) return;

  const parsed = EnrichmentSubmissionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ success: false, error: "Malformed submission", details: parsed.error.issues });
    return;
  }

  try {
    const [pending, cats] = await Promise.all([
      selectPendingEnrichment(1000),
      supabase.from("categories").select("slug").or(`is_system.eq.true,user_id.eq.${user.id}`),
    ]);
    const mine = pending.filter((p) => p.user_id === user.id);
    const offered = new Set(mine.map((p) => p.id));
    const slugs = new Set((cats.data ?? []).map((c: { slug: string }) => c.slug.toLowerCase()));

    const { accepted, errors } = verifyEnrichment(parsed.data, offered, slugs);
    if (accepted.length === 0) {
      res.status(errors.length > 0 ? 422 : 200).json({ success: errors.length === 0, stored: 0, errors });
      return;
    }

    const noteById = new Map(mine.map((p) => [p.id, p.notes]));
    // The hash is what marks a row enriched, so it must be the note the agent
    // was actually shown. Recomputing from a note edited mid-run would mark the
    // row done against text nobody labelled.
    const rows = accepted.map((a) => ({
      transaction_id: a.id,
      user_id: user.id,
      lending: a.lending,
      category_suggestion: a.category_suggestion,
      service_identity: a.service_identity,
      note_hash: noteHash(noteById.get(a.id) ?? ""),
      model: parsed.data.model,
      enriched_at: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from("txn_enrichment")
      .upsert(rows, { onConflict: "transaction_id" });
    if (error) throw new Error(`enrichment upsert failed: ${error.message}`);

    res.json({ success: true, stored: rows.length, skipped: errors.length, errors });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
