import { supabase } from "./supabase.js";

// Backend copy of the frontend matcher + occurrence-summary. The two repos don't
// share a package, so this mirrors MT-Wallet/src/lib/subscription{Match,Compute}.ts.
// Keep them in sync: note (primary) > merchant > amount; note match alone is HIGH.

const W_NOTE = 0.6;
const W_MERCHANT = 0.4;
const W_AMOUNT = 0.1;
const IDENTITY_BOOST = 0.3;
const HIGH = 0.6;
const DAY_MS = 86_400_000;

const CADENCES: { name: string; center: number; tol: number }[] = [
  { name: "weekly", center: 7, tol: 2 },
  { name: "monthly", center: 30, tol: 7 },
  { name: "quarterly", center: 91, tol: 12 },
  { name: "annual", center: 365, tol: 20 },
];

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

function tokens(s: string | null | undefined): string[] {
  return norm(s)
    .replace(/^#\w+\s*\|\s*/, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function textSimilarity(a: string | null, b: string | null): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb || na.includes(nb) || nb.includes(na)) return 1;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function amountProximity(a: number, b: number | null): number {
  if (!b || b <= 0) return 0;
  const ratio = Math.min(a, b) / Math.max(a, b);
  return ratio > 0.8 ? (ratio - 0.8) / 0.2 : 0;
}

interface CandidateTxn {
  id: string;
  merchant: string | null;
  notes: string | null;
  amount: number;
  transacted_at: string;
  serviceIdentity: string | null;
}

interface Sub {
  id: string;
  match_note: string | null;
  match_merchant: string | null;
  identity: string | null;
  median_amount: number | null;
}

function scoreMatch(txn: CandidateTxn, s: Sub): number {
  let score = 0;
  if (s.match_note) score += W_NOTE * textSimilarity(txn.notes, s.match_note);
  if (s.match_merchant) score += W_MERCHANT * textSimilarity(txn.merchant, s.match_merchant);
  if (s.identity && txn.serviceIdentity && norm(s.identity) === norm(txn.serviceIdentity)) score += IDENTITY_BOOST;
  score += W_AMOUNT * amountProximity(txn.amount, s.median_amount);
  return Math.min(score, 1);
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function loadAllRows(table: string, cols: string, userId: string): Promise<any[]> {
  const PAGE = 1000;
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(cols)
      .eq("user_id", userId)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} load failed: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function recomputeSubscription(subscriptionId: string) {
  const { data, error } = await supabase
    .from("subscription_transactions")
    .select("amount, transacted_at")
    .eq("subscription_id", subscriptionId);
  if (error) throw new Error(error.message);
  const occ = (data ?? []).map((o: any) => ({ amount: Number(o.amount), transacted_at: o.transacted_at }));
  const amounts = occ.map((o) => o.amount);
  const sortedAmts = [...amounts].sort((a, b) => a - b);
  const byTime = [...occ].sort((a, b) => +new Date(a.transacted_at) - +new Date(b.transacted_at));
  const times = byTime.map((o) => +new Date(o.transacted_at));

  const patch: Record<string, unknown> = {
    median_amount: Math.round(median(sortedAmts) * 100) / 100,
    amount_min: amounts.length ? Math.min(...amounts) : 0,
    amount_max: amounts.length ? Math.max(...amounts) : 0,
    last_amount: byTime.length ? byTime[byTime.length - 1].amount : 0,
    updated_at: new Date().toISOString(),
  };

  if (times.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY_MS);
    const medianGap = median([...gaps].sort((a, b) => a - b));
    const matched = CADENCES.find((c) => Math.abs(medianGap - c.center) <= c.tol);
    patch.cadence = matched?.name ?? "irregular";
    patch.predicted_next = new Date(times[times.length - 1] + medianGap * DAY_MS).toISOString().slice(0, 10);
  }

  const { error: upErr } = await supabase.from("subscriptions").update(patch).eq("id", subscriptionId);
  if (upErr) throw new Error(upErr.message);
}

// Nightly: link newly-noted/enriched debit transactions to active subscriptions
// (deterministic, HIGH only), then re-predict the affected subscriptions. Client
// note-edit already links live; this catches anything missed and applies the
// service_identity signal that only exists after enrichment.
export async function reconcileSubscriptions(): Promise<{ linked: number; users: number }> {
  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select("id, user_id, match_note, match_merchant, identity, median_amount")
    .eq("status", "active");
  if (error) throw new Error(`subscriptions load failed: ${error.message}`);
  if (!subs || subs.length === 0) return { linked: 0, users: 0 };

  const byUser = new Map<string, Sub[]>();
  for (const s of subs as any[]) {
    (byUser.get(s.user_id) ?? byUser.set(s.user_id, []).get(s.user_id)!).push(s);
  }

  let linked = 0;
  for (const [userId, userSubs] of byUser) {
    const linkedRows = await loadAllRows("subscription_transactions", "transaction_id", userId);
    const alreadyLinked = new Set(linkedRows.map((r: any) => r.transaction_id));

    const identityRows = await loadAllRows("txn_enrichment", "transaction_id, service_identity", userId);
    const identityBy = new Map<string, string | null>(
      identityRows.map((r: any) => [r.transaction_id, r.service_identity]),
    );

    const txnRows = await loadAllRows("transactions", "id, merchant, notes, amount, transacted_at, direction", userId);
    const candidates: CandidateTxn[] = txnRows
      .filter((t: any) => t.direction === "debit" && !alreadyLinked.has(t.id) && norm(t.notes) !== "")
      .map((t: any) => ({
        id: t.id,
        merchant: t.merchant,
        notes: t.notes,
        amount: Number(t.amount),
        transacted_at: t.transacted_at,
        serviceIdentity: identityBy.get(t.id) ?? null,
      }));

    const affected = new Set<string>();
    for (const txn of candidates) {
      let best: Sub | null = null;
      let bestScore = 0;
      for (const s of userSubs) {
        const sc = scoreMatch(txn, s);
        if (sc > bestScore) {
          bestScore = sc;
          best = s;
        }
      }
      if (!best || bestScore < HIGH) continue;
      const { error: linkErr } = await supabase.from("subscription_transactions").upsert(
        {
          subscription_id: best.id,
          transaction_id: txn.id,
          user_id: userId,
          amount: txn.amount,
          transacted_at: txn.transacted_at,
          linked_by: "auto",
        },
        { onConflict: "transaction_id" },
      );
      if (linkErr) throw new Error(`link failed: ${linkErr.message}`);
      affected.add(best.id);
      linked++;
    }

    for (const id of affected) await recomputeSubscription(id);
  }

  return { linked, users: byUser.size };
}
