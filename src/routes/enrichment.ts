import { Router, type Request, type Response } from "express";
import { getUserByApiKey } from "../services/supabase.js";
import { selectPendingEnrichment, noteHash, maySuggestCategory } from "../services/enrichmentPending.js";
import { linkToSubscriptions } from "../services/enrichmentLink.js";
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

/** The subscriptions the agent chooses from, each with the merchant spellings
 *  already attached to it. Answering "is this one of these?" only works if the
 *  list is in front of it; without that the agent wrote a service name as free
 *  text and the server tried to match the string back, which is how a charge
 *  spelled "policy bazzar" reached Life Insurance by luck rather than by
 *  reading. */
async function subscriptionChoices(userId: string) {
  const [{ data: subs, error }, { data: links, error: linkErr }] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("id, label, cadence, median_amount")
      .eq("user_id", userId)
      .eq("status", "active"),
    supabase
      .from("subscription_transactions")
      .select("subscription_id, transactions(merchant)")
      .eq("user_id", userId)
      .eq("kind", "charge"),
  ]);
  if (error) throw new Error(`subscriptions: ${error.message}`);
  if (linkErr) throw new Error(`subscription_transactions: ${linkErr.message}`);

  const merchants = new Map<string, Set<string>>();
  for (const l of (links ?? []) as any[]) {
    const m = (l.transactions?.merchant ?? "").trim().toLowerCase();
    if (!m) continue;
    const set = merchants.get(l.subscription_id) ?? new Set<string>();
    set.add(m);
    merchants.set(l.subscription_id, set);
  }

  return ((subs ?? []) as any[]).map((s) => ({
    id: s.id,
    label: s.label,
    cadence: s.cadence,
    median_amount: s.median_amount === null ? null : Number(s.median_amount),
    merchants: [...(merchants.get(s.id) ?? [])].sort(),
  }));
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
    const [pending, cats, subscriptions] = await Promise.all([
      selectPendingEnrichment(limit, relabelBefore),
      categorySlugs(user.id),
      subscriptionChoices(user.id),
    ]);
    const mine = pending.filter((p) => p.user_id === user.id);
    res.json({
      success: true,
      known_category_slugs: (cats.data ?? []).map((c: { slug: string }) => c.slug).sort(),
      subscriptions,
      relabel_before: relabelBefore ?? null,
      count: mine.length,
      transactions: mine.map((p) => ({
        id: p.id,
        note: p.notes,
        merchant: p.merchant,
        amount: p.amount,
        direction: p.direction,
        current_category: p.category,
        reason: p.reason,
        // Resolved here so the agent never has to reason about why a row came
        // back. A backfill re-offer gets its missing fields filled in and its
        // settled category left alone.
        suggest_category: maySuggestCategory(p.reason),
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
    const [pending, cats, subscriptions] = await Promise.all([
      selectPendingEnrichment(1000, parsed.data.relabel_before),
      categorySlugs(user.id),
      subscriptionChoices(user.id),
    ]);
    const mine = pending.filter((p) => p.user_id === user.id);
    const offered = new Set(mine.map((p) => p.id));
    const slugs = new Set((cats.data ?? []).map((c: { slug: string }) => c.slug.toLowerCase()));

    const { accepted, errors } = verifyEnrichment(parsed.data, offered, slugs, {
      suggestableIds: new Set(mine.filter((p) => maySuggestCategory(p.reason)).map((p) => p.id)),
      knownSubscriptionIds: new Set(subscriptions.map((s) => s.id)),
    });
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

    // Linking runs after the labels are safely stored. A failure here must not
    // discard a batch of good enrichment, so it is reported, not thrown.
    let links = { linked: 0, skipped: [] as { transactionId: string; reason: string }[], recomputed: [] as string[] };
    try {
      links = await linkToSubscriptions(
        user.id,
        accepted
          .filter((a) => a.subscription_id)
          .map((a) => ({ transactionId: a.id, subscriptionId: a.subscription_id! })),
      );
    } catch (linkErr) {
      errors.push(`subscription linking failed: ${(linkErr as Error).message}`);
    }

    res.json({
      success: true,
      stored: rows.length,
      skipped: errors.length,
      errors,
      linked: links.linked,
      link_skipped: links.skipped,
      subscriptions_recomputed: links.recomputed.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
