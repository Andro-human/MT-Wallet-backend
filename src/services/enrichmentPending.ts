import { createHash } from "node:crypto";
import { supabase } from "./supabase.js";

export function noteHash(note: string): string {
  return createHash("sha256").update(note.trim()).digest("hex");
}

export type PendingReason = "new" | "note_changed" | "backfill";

export type PendingTxn = {
  id: string;
  user_id: string;
  notes: string;
  merchant: string | null;
  amount: number;
  direction: string | null;
  category: string;
  reason: PendingReason;
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
/** Why this row is being offered, which is not the same question as whether.
 *
 *  A row re-offered only because it predates the cutoff has already had its
 *  category looked at, by the agent or by the user. Suggesting a new one is
 *  noise: the inbox filled with proposals reaching back to April, none of them
 *  prompted by anything that changed. Only "new" and "note_changed" are grounds
 *  for a category suggestion; "backfill" exists to fill in fields added after
 *  the fact, and nothing more.
 */
export function pendingReason(
  note: string,
  existing: ExistingEnrichment,
  relabelBefore?: string,
): PendingReason | null {
  if (!existing) return "new";
  if (existing.note_hash !== noteHash(note)) return "note_changed";
  if (relabelBefore && existing.model !== MANUAL_MODEL) {
    const cutoff = Date.parse(relabelBefore);
    // An unparsable cutoff must not silently re-offer the whole table.
    if (Number.isFinite(cutoff) && Date.parse(existing.enriched_at) < cutoff) return "backfill";
  }
  return null;
}

export function isPending(
  note: string,
  existing: ExistingEnrichment,
  relabelBefore?: string,
): boolean {
  return pendingReason(note, existing, relabelBefore) !== null;
}

/** A category suggestion is only wanted where something actually changed. */
export const maySuggestCategory = (reason: PendingReason) => reason !== "backfill";

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
      "id, user_id, notes, merchant, amount, direction, transacted_at, categories(slug), txn_enrichment(note_hash, model, enriched_at)",
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
    const reason = pendingReason(note, existing, relabelBefore);
    if (!reason) continue;
    rows.push({
      id: t.id,
      user_id: t.user_id,
      notes: note,
      merchant: t.merchant,
      amount: Number(t.amount),
      direction: (t as { direction?: string | null }).direction ?? null,
      category: (t.categories as unknown as { slug: string } | null)?.slug ?? "other",
      reason,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}
