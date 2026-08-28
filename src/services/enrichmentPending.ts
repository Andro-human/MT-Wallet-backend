import { createHash } from "node:crypto";
import { supabase } from "./supabase.js";

export function noteHash(note: string): string {
  return createHash("sha256").update(note.trim()).digest("hex");
}

export type PendingTxn = {
  id: string;
  user_id: string;
  notes: string;
  merchant: string | null;
  amount: number;
  category: string;
};

export type ExistingEnrichment = {
  note_hash: string;
  model: string;
  enriched_at: string;
} | null;

export const MANUAL_MODEL = "manual";

/** Whether a noted transaction still needs the agent to look at it.
 *
 *  `relabelBefore` re-offers rows enriched before a cutoff. That is the only way
 *  a field added after the fact gets backfilled: service_identity is null both
 *  for "not a recurring service" and for "nobody ever asked", so the column
 *  cannot tell those apart, but the enrichment date can.
 *
 *  Manual rows are never re-offered at any cutoff. They carry the user's own
 *  dismissals and lending marks, and the submit upsert would overwrite them.
 */
export function isPending(
  note: string,
  existing: ExistingEnrichment,
  relabelBefore?: string,
): boolean {
  if (!existing) return true;
  if (existing.note_hash !== noteHash(note)) return true;
  if (relabelBefore && existing.model !== MANUAL_MODEL) {
    const cutoff = Date.parse(relabelBefore);
    // An unparsable cutoff must not silently re-offer the whole table.
    if (Number.isFinite(cutoff) && Date.parse(existing.enriched_at) < cutoff) return true;
  }
  return false;
}

/**
 * Noted transactions that need enrichment: no txn_enrichment row yet, the note
 * changed since it was enriched, or (with relabelBefore) the row predates the
 * cutoff.
 */
export async function selectPendingEnrichment(
  limit: number,
  relabelBefore?: string,
): Promise<PendingTxn[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select(
      "id, user_id, notes, merchant, amount, transacted_at, categories(slug), txn_enrichment(note_hash, model, enriched_at)",
    )
    .not("notes", "is", null)
    .neq("notes", "")
    .order("transacted_at", { ascending: false })
    .limit(5000);
  if (error) throw new Error(`enrichment selection failed: ${error.message}`);

  const rows: PendingTxn[] = [];
  for (const t of data ?? []) {
    const note = (t.notes ?? "").trim();
    if (!note) continue;
    const existing = (t.txn_enrichment as unknown as ExistingEnrichment) ?? null;
    if (!isPending(note, existing, relabelBefore)) continue;
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
