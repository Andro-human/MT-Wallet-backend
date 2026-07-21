import { createHash } from "node:crypto";
import { supabase, insertSyncRun } from "./supabase.js";
import { enrichTransactions, type EnrichInput } from "./enrichment.js";
import type { ModelUsage } from "./ai.js";

const INR_PER_USD = 95.2;
export const PRICES_PER_M: Record<string, { input: number; output: number }> = {
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
};

export function noteHash(note: string): string {
  return createHash("sha256").update(note.trim()).digest("hex");
}

export function costRupees(
  model: string,
  usage: { input: number; output: number; reasoning: number },
): number {
  const p = PRICES_PER_M[model];
  if (!p) return 0;
  return ((usage.input * p.input + (usage.output + usage.reasoning) * p.output) / 1_000_000) * INR_PER_USD;
}

export type PendingTxn = {
  id: string;
  user_id: string;
  notes: string;
  merchant: string | null;
  amount: number;
  category: string;
};

/**
 * Noted transactions that need enrichment: no txn_enrichment row yet, or the
 * note changed since it was enriched (note_hash mismatch).
 */
export async function selectPendingEnrichment(limit: number): Promise<PendingTxn[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select("id, user_id, notes, merchant, amount, transacted_at, categories(slug), txn_enrichment(note_hash)")
    .not("notes", "is", null)
    .neq("notes", "")
    .order("transacted_at", { ascending: false })
    .limit(5000);
  if (error) throw new Error(`enrichment selection failed: ${error.message}`);

  const rows: PendingTxn[] = [];
  for (const t of data ?? []) {
    const note = (t.notes ?? "").trim();
    if (!note) continue;
    const existing = (t.txn_enrichment as unknown as { note_hash: string } | null) ?? null;
    if (existing && existing.note_hash === noteHash(note)) continue;
    rows.push({
      id: t.id,
      user_id: t.user_id,
      notes: note,
      merchant: t.merchant,
      amount: Number(t.amount),
      category: (t.categories as unknown as { slug: string } | null)?.slug ?? "other",
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** Existing item_labels per category — fed to the prompt so labels stay coarse and consistent. */
export async function loadVocabulary(categories: string[]): Promise<Record<string, string[]>> {
  const { data, error } = await supabase
    .from("txn_enrichment")
    .select("item_label, transactions(categories(slug))");
  if (error) throw new Error(`vocabulary load failed: ${error.message}`);
  const vocab: Record<string, Set<string>> = {};
  for (const row of data ?? []) {
    const slug = (row.transactions as unknown as { categories: { slug: string } | null } | null)
      ?.categories?.slug;
    if (!slug || !categories.includes(slug)) continue;
    (vocab[slug] ??= new Set()).add(row.item_label);
  }
  return Object.fromEntries(Object.entries(vocab).map(([k, v]) => [k, [...v].sort()]));
}

export interface EnrichmentPassResult {
  pending: number;
  enriched: number;
  batches: number;
  usage: ModelUsage;
  rupees: number;
  stoppedBySpend: boolean;
}

let passRunning = false;

export async function runEnrichmentPass(opts?: {
  limit?: number;
  batchSize?: number;
  model?: string;
  maxRupees?: number;
}): Promise<EnrichmentPassResult> {
  const limit = opts?.limit ?? 200;
  const batchSize = opts?.batchSize ?? 30;
  const model = opts?.model ?? "gemini-2.5-flash";
  const maxRupees = opts?.maxRupees ?? 5;

  if (passRunning) throw new Error("enrichment pass already running");
  passRunning = true;
  const startedAt = new Date();
  const usage: ModelUsage = { [model]: { input: 0, output: 0, reasoning: 0 } };
  let enriched = 0;
  let batches = 0;
  let rupees = 0;
  let stoppedBySpend = false;

  try {
    const pending = await selectPendingEnrichment(limit);
    if (pending.length === 0) {
      return { pending: 0, enriched: 0, batches: 0, usage, rupees: 0, stoppedBySpend: false };
    }

    const { data: catRows, error: catErr } = await supabase.from("categories").select("slug");
    if (catErr) throw new Error(`categories load failed: ${catErr.message}`);
    const allSlugs = [...new Set((catRows ?? []).map((c) => c.slug as string))];

    for (let i = 0; i < pending.length; i += batchSize) {
      if (rupees >= maxRupees) {
        stoppedBySpend = true;
        console.warn(`[enrichment] spend ceiling ₹${maxRupees} hit after ${enriched} txns`);
        break;
      }
      const batch = pending.slice(i, i + batchSize);
      const vocab = await loadVocabulary([...new Set(batch.map((b) => b.category))]);
      const inputs: EnrichInput[] = batch.map((b) => ({
        id: b.id,
        note: b.notes,
        merchant: b.merchant,
        amount: b.amount,
        current_category: b.category,
      }));

      const res = await enrichTransactions(inputs, allSlugs, vocab, model);
      usage[model].input += res.input;
      usage[model].output += res.output;
      usage[model].reasoning += res.reasoning;
      rupees += costRupees(model, res);
      batches++;

      const byId = new Map(batch.map((b) => [b.id, b]));
      const rows = res.results
        .filter((r) => byId.has(r.id))
        .map((r) => ({
          transaction_id: r.id,
          user_id: byId.get(r.id)!.user_id,
          item_label: r.item_label,
          lending: r.lending,
          category_suggestion: r.category_suggestion,
          service_identity: r.service_identity ?? null,
          note_hash: noteHash(byId.get(r.id)!.notes),
          model,
          enriched_at: new Date().toISOString(),
        }));
      const { error } = await supabase.from("txn_enrichment").upsert(rows);
      if (error) throw new Error(`enrichment upsert failed: ${error.message}`);
      enriched += rows.length;
    }

    // Surface the run (and its true token cost, thinking included) in the
    // existing sync-runs UI instead of a parallel bookkeeping table.
    const completedAt = new Date();
    await insertSyncRun({
      userId: pending[0].user_id,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      status: "success",
      totalMessages: pending.length,
      inserted: enriched,
      skipped: pending.length - enriched,
      errors: 0,
      messages: [],
      details: [],
      source: "enrichment",
      usage,
    });

    console.log(
      `[enrichment] pass done: ${enriched}/${pending.length} txns in ${batches} batches, ` +
        `tokens in=${usage[model].input} out=${usage[model].output} think=${usage[model].reasoning}, ₹${rupees.toFixed(3)}`,
    );
    return { pending: pending.length, enriched, batches, usage, rupees, stoppedBySpend };
  } finally {
    passRunning = false;
  }
}
