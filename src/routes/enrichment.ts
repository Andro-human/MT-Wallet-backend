import { Router, type Request, type Response } from "express";
import { getUserByApiKey } from "../services/supabase.js";
import { selectPendingEnrichment, noteHash } from "../services/enrichmentPending.js";
import { supabase } from "../services/supabase.js";
import {
  EnrichmentSubmissionSchema,
  verifyEnrichment,
} from "../services/enrichmentSubmit.js";

const router = Router();

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

function categorySlugs(userId: string) {
  return supabase.from("categories").select("slug, name").or(`is_system.eq.true,user_id.eq.${userId}`);
}

/** Transactions needing enrichment, for the nightly agent.
 *
 *  A noted transaction with no enrichment row, or one whose note changed since
 *  (note_hash mismatch). Pass relabel_before to also re-offer rows enriched
 *  before that instant, which is how a field added after the fact gets
 *  backfilled. The agent gets the note, merchant, amount and current category,
 *  plus the category vocabulary.
 */
router.get("/pending", async (req: Request, res: Response) => {
  const user = await authed(req, res);
  if (!user) return;

  const limit = Math.min(Number(req.query.limit ?? 300) || 300, 1000);
  const raw = req.query.relabel_before;
  const relabelBefore = typeof raw === "string" && raw ? raw : undefined;
  if (relabelBefore && !Number.isFinite(Date.parse(relabelBefore))) {
    res.status(422).json({ success: false, error: `relabel_before is not a parsable date: "${relabelBefore}"` });
    return;
  }

  try {
    const [pending, cats] = await Promise.all([
      selectPendingEnrichment(limit, relabelBefore),
      categorySlugs(user.id),
    ]);
    const mine = pending.filter((p) => p.user_id === user.id);
    res.json({
      success: true,
      known_category_slugs: (cats.data ?? []).map((c: { slug: string }) => c.slug).sort(),
      relabel_before: relabelBefore ?? null,
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
    // Same cutoff the agent fetched with, or its ids would not be in the
    // offered set and a whole backfill batch would come back rejected.
    const [pending, cats] = await Promise.all([
      selectPendingEnrichment(1000, parsed.data.relabel_before),
      categorySlugs(user.id),
    ]);
    const mine = pending.filter((p) => p.user_id === user.id);
    const offered = new Set(mine.map((p) => p.id));
    const slugs = new Set((cats.data ?? []).map((c: { slug: string }) => c.slug.toLowerCase()));

    const { accepted, errors } = verifyEnrichment(parsed.data, offered, slugs);
    if (accepted.length === 0) {
      res.status(errors.length > 0 ? 422 : 200).json({ success: errors.length === 0, stored: 0, errors });
      return;
    }

    // budget_excluded is the user's alone; the agent never proposes it. Carried
    // forward explicitly rather than trusting an omitted column to survive the
    // upsert. Reading only the true rows keeps this off the URL-length cliff an
    // .in() over a thousand uuids would hit.
    const { data: excludedRows, error: exErr } = await supabase
      .from("txn_enrichment")
      .select("transaction_id")
      .eq("user_id", user.id)
      .eq("budget_excluded", true);
    if (exErr) throw new Error(`budget_excluded read failed: ${exErr.message}`);
    const excluded = new Set((excludedRows ?? []).map((r: { transaction_id: string }) => r.transaction_id));

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
      budget_excluded: excluded.has(a.id),
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
