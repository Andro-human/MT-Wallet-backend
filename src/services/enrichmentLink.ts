import { supabase } from "./supabase.js";
import { recomputeSubscription } from "./subscriptionSync.js";

/**
 * Attaching a charge to the subscription the agent named.
 *
 * The agent picks from a list of real subscriptions, so there is nothing to
 * string-match and nothing to guess. What the server still owns: every figure
 * on the subscription is recomputed from its linked rows afterwards, and a link
 * the user made by hand is never moved.
 */

export interface LinkRequest {
  transactionId: string;
  subscriptionId: string;
}

export interface LinkOutcome {
  linked: number;
  skipped: { transactionId: string; reason: string }[];
  recomputed: string[];
}

/** Credits against a subscription are contributions, not charges: a housemate
 *  repaying their share of the family plan must not count as the plan billing
 *  again. Cadence and median are computed from charges alone. */
const kindFor = (direction: string | null | undefined) =>
  direction === "credit" ? "contribution" : "charge";

export function planLinks(
  requests: LinkRequest[],
  existing: Map<string, string>,
  manual: Set<string>,
): { insert: LinkRequest[]; skipped: LinkOutcome["skipped"] } {
  const insert: LinkRequest[] = [];
  const skipped: LinkOutcome["skipped"] = [];

  for (const r of requests) {
    const current = existing.get(r.transactionId);
    if (current === r.subscriptionId) continue;
    if (current) {
      // The user may have moved this row deliberately. A nightly run that
      // reassigns it would undo that silently, every night, forever.
      skipped.push({
        transactionId: r.transactionId,
        reason: manual.has(r.transactionId)
          ? "already linked by hand to another subscription"
          : "already linked to another subscription",
      });
      continue;
    }
    insert.push(r);
  }
  return { insert, skipped };
}

export async function linkToSubscriptions(
  userId: string,
  requests: LinkRequest[],
): Promise<LinkOutcome> {
  if (requests.length === 0) return { linked: 0, skipped: [], recomputed: [] };

  const ids = [...new Set(requests.map((r) => r.transactionId))];

  const [{ data: links, error: linkErr }, { data: txns, error: txnErr }] = await Promise.all([
    supabase
      .from("subscription_transactions")
      .select("transaction_id, subscription_id, linked_by")
      .eq("user_id", userId)
      .in("transaction_id", ids),
    supabase
      .from("transactions")
      .select("id, amount, transacted_at, direction")
      .eq("user_id", userId)
      .in("id", ids),
  ]);
  if (linkErr) throw new Error(`subscription_transactions read failed: ${linkErr.message}`);
  if (txnErr) throw new Error(`transactions read failed: ${txnErr.message}`);

  const existing = new Map((links ?? []).map((l: any) => [l.transaction_id, l.subscription_id]));
  const manual = new Set(
    (links ?? []).filter((l: any) => l.linked_by === "manual").map((l: any) => l.transaction_id),
  );
  const txnById = new Map((txns ?? []).map((t: any) => [t.id, t]));

  const { insert, skipped } = planLinks(requests, existing, manual);

  const rows = insert
    .filter((r) => {
      if (txnById.has(r.transactionId)) return true;
      skipped.push({ transactionId: r.transactionId, reason: "transaction not found" });
      return false;
    })
    .map((r) => {
      const t = txnById.get(r.transactionId)!;
      return {
        subscription_id: r.subscriptionId,
        transaction_id: r.transactionId,
        user_id: userId,
        amount: Number(t.amount),
        transacted_at: t.transacted_at,
        linked_by: "auto",
        kind: kindFor(t.direction),
      };
    });

  if (rows.length > 0) {
    const { error } = await supabase
      .from("subscription_transactions")
      .upsert(rows, { onConflict: "transaction_id" });
    if (error) throw new Error(`subscription link failed: ${error.message}`);
  }

  const touched = [...new Set(rows.map((r) => r.subscription_id))];
  for (const id of touched) await recomputeSubscription(id);

  return { linked: rows.length, skipped, recomputed: touched };
}
