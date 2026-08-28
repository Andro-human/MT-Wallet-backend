import { z } from "zod";
import { supabase } from "./supabase.js";
import { scoreCluster } from "./proposalMath.js";

/**
 * Run 3: finding subscriptions that are in the data but not on the books.
 *
 * Linking a charge to a subscription you already have is Run 1's job and the
 * reconcile timer's; this run only discovers. Cadence is invisible inside one
 * month, so the agent gets history — grouped by merchant, which is mechanical
 * compression and not a judgement about what recurs. Filtering the candidates
 * first would be the server deciding the very thing the agent is here to
 * decide.
 *
 * `existing` and `dismissed` are do-not-propose lists. Without them the agent
 * offered "Policybazaar" as new while twelve of its charges were already linked
 * to "Life Insurance" under five different merchant spellings.
 */

const MERCHANT_STOPLIST = new Set(["debit", "credit", "upi", "neft", "imps", "atm", "cash"]);

export interface DiscoveryTxn {
  n: number;
  d: string;
  amount: number;
}
export interface DiscoveryMerchant {
  m: string;
  txns: DiscoveryTxn[];
}
export interface DiscoveryPayload {
  window: { from: string; to: string };
  existing: {
    label: string;
    cadence: string | null;
    median_amount: number | null;
    merchants: string[];
    last_seen: string | null;
  }[];
  dismissed: { label: string; merchants: string[] }[];
  merchants: DiscoveryMerchant[];
  ordinals: number;
}

// orderBy must be a unique column, or paging past 1000 rows can repeat and skip.
// subscription_transactions is keyed on the pair and has no id at all.
async function fetchAll<T>(
  table: string,
  columns: string,
  filter: (q: any) => any,
  orderBy = "id",
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filter(
      supabase.from(table).select(columns).order(orderBy, { ascending: true }),
    ).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

export const normalizeMerchant = (m: string) => m.trim().toLowerCase();
const isVpaLike = (m: string) => m.includes("@");

export function isCandidate(t: {
  direction?: string | null;
  merchant?: string | null;
  is_expense?: boolean | null;
}): boolean {
  if (t.direction === "credit") return false;
  if (!t.is_expense) return false;
  const key = normalizeMerchant(t.merchant ?? "");
  return !!key && !MERCHANT_STOPLIST.has(key) && !isVpaLike(key);
}

/** Ordinals must mean the same thing when the agent submits as when it read,
 *  so the ordering is fixed here and nowhere else: merchant, then date, then id. */
export function assignOrdinals<T extends { id: string; merchant: string | null; transacted_at: string }>(
  txns: T[],
): { merchant: string; rows: (T & { n: number })[] }[] {
  const groups = new Map<string, T[]>();
  for (const t of txns) {
    const key = normalizeMerchant(t.merchant ?? "");
    const bucket = groups.get(key);
    if (bucket) bucket.push(t);
    else groups.set(key, [t]);
  }
  let n = 0;
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([merchant, rows]) => ({
      merchant,
      rows: rows
        .sort((a, b) =>
          a.transacted_at === b.transacted_at
            ? a.id < b.id
              ? -1
              : 1
            : a.transacted_at < b.transacted_at
              ? -1
              : 1,
        )
        .map((r) => ({ ...r, n: ++n })),
    }));
}

interface CandidateRow {
  id: string;
  merchant: string | null;
  amount: string | number;
  transacted_at: string;
  direction: string | null;
  is_expense: boolean | null;
}

async function loadCandidates(userId: string, windowMonths: number) {
  const from = new Date();
  from.setUTCMonth(from.getUTCMonth() - windowMonths);
  const fromIso = from.toISOString();

  const [txns, links, duplicates] = await Promise.all([
    fetchAll<CandidateRow>(
      "transactions",
      "id, merchant, amount, transacted_at, direction, is_expense",
      (q) => q.eq("user_id", userId).gte("transacted_at", fromIso),
    ),
    fetchAll<{ transaction_id: string }>(
      "subscription_transactions",
      "transaction_id",
      (q) => q.eq("user_id", userId),
      "transaction_id",
    ),
    fetchAll<{ duplicate_transaction_id: string }>(
      "duplicate_links",
      "duplicate_transaction_id",
      (q) => q.eq("user_id", userId),
    ),
  ]);

  // A charge already attached to a subscription is not evidence of an
  // undiscovered one. Leaving these in is what let Policybazaar be proposed
  // twice: its rows were linked, but detection never looked.
  const excluded = new Set([
    ...links.map((l) => l.transaction_id),
    ...duplicates.map((d) => d.duplicate_transaction_id),
  ]);

  const kept = txns.filter((t) => !excluded.has(t.id) && isCandidate(t));
  return {
    from: fromIso.slice(0, 10),
    rows: kept.map((t) => ({
      id: t.id,
      merchant: t.merchant,
      transacted_at: t.transacted_at,
      amount: Number(t.amount),
    })),
  };
}

/** The payload plus the ordinal→id mapping behind it. Submission has to resolve
 *  ordinals against the same window the agent read, or a proposal would name
 *  different transactions than the ones it was reasoning about. */
export async function buildDiscovery(
  userId: string,
  windowMonths = 24,
): Promise<{ payload: DiscoveryPayload; idByOrdinal: Map<number, string> }> {
  const months = Math.min(Math.max(windowMonths, 3), 60);
  const [{ from, rows }, subs, proposals] = await Promise.all([
    loadCandidates(userId, months),
    supabase
      .from("subscriptions")
      .select("id, label, cadence, median_amount, match_merchant, identity")
      .eq("user_id", userId)
      .then(({ data, error }) => {
        if (error) throw new Error(`subscriptions: ${error.message}`);
        return data ?? [];
      }),
    supabase
      .from("subscription_proposals")
      .select("label, status, transaction_ids")
      .eq("user_id", userId)
      .then(({ data, error }) => {
        if (error) throw new Error(`subscription_proposals: ${error.message}`);
        return data ?? [];
      }),
  ]);

  const linked = await loadLinkedFacts(userId);
  const grouped = assignOrdinals(rows);
  const idByOrdinal = new Map<number, string>();
  for (const g of grouped) for (const r of g.rows) idByOrdinal.set(r.n, r.id);

  const payload: DiscoveryPayload = {
    window: { from, to: new Date().toISOString().slice(0, 10) },
    existing: (subs as any[]).map((s) => ({
      label: s.label,
      cadence: s.cadence,
      median_amount: s.median_amount === null ? null : Number(s.median_amount),
      merchants: linked.get(s.id)?.merchants ?? [],
      last_seen: linked.get(s.id)?.lastSeen ?? null,
    })),
    dismissed: (proposals as any[])
      .filter((p) => p.status === "dismissed")
      .map((p) => ({ label: p.label, merchants: [] })),
    merchants: grouped.map((g) => ({
      m: g.merchant,
      txns: g.rows.map((r) => ({ n: r.n, d: r.transacted_at.slice(0, 10), amount: r.amount })),
    })),
    ordinals: rows.length,
  };
  return { payload, idByOrdinal };
}

export const buildDiscoveryPayload = async (userId: string, windowMonths = 24) =>
  (await buildDiscovery(userId, windowMonths)).payload;

/** The merchant spellings already attached to each subscription, and when it
 *  last charged. This is the part that stops a duplicate proposal: the agent can
 *  see that "policy bazar", "POLICYBAZAAR" and "axis max life insurance" are all
 *  one thing already. */
async function loadLinkedFacts(
  userId: string,
): Promise<Map<string, { merchants: string[]; lastSeen: string | null }>> {
  const links = await fetchAll<{ subscription_id: string; transaction_id: string }>(
    "subscription_transactions",
    "subscription_id, transaction_id",
    (q) => q.eq("user_id", userId).eq("kind", "charge"),
    "transaction_id",
  );
  if (links.length === 0) return new Map();

  const byTxn = new Map(links.map((l) => [l.transaction_id, l.subscription_id]));
  const txns = await fetchAll<{ id: string; merchant: string | null; transacted_at: string }>(
    "transactions",
    "id, merchant, transacted_at",
    (q) => q.eq("user_id", userId).in("id", [...byTxn.keys()]),
  );

  const acc = new Map<string, { merchants: Set<string>; lastSeen: string | null }>();
  for (const t of txns) {
    const sub = byTxn.get(t.id);
    if (!sub) continue;
    const entry = acc.get(sub) ?? { merchants: new Set<string>(), lastSeen: null };
    const m = normalizeMerchant(t.merchant ?? "");
    if (m) entry.merchants.add(m);
    const d = t.transacted_at.slice(0, 10);
    if (!entry.lastSeen || d > entry.lastSeen) entry.lastSeen = d;
    acc.set(sub, entry);
  }
  return new Map(
    [...acc].map(([k, v]) => [k, { merchants: [...v.merchants].sort(), lastSeen: v.lastSeen }]),
  );
}

export const ProposalSubmissionSchema = z.object({
  model: z.string().max(80).default("claude-routine"),
  proposals: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        ordinals: z.array(z.number().int().positive()).min(3).max(500),
        rationale: z.string().trim().max(400).nullable().default(null),
      }),
    )
    .max(40)
    .default([]),
});
export type ProposalSubmission = z.infer<typeof ProposalSubmissionSchema>;

export interface ProposalOutcome {
  label: string;
  stored: boolean;
  reason?: string;
}

export function resolveProposals(
  payload: { merchants: DiscoveryMerchant[] },
  submission: ProposalSubmission,
  now: Date,
): { rows: (ReturnType<typeof scoreCluster> & { label: string; rationale: string | null; ordinals: number[] })[]; outcomes: ProposalOutcome[] } {
  const byOrdinal = new Map<number, DiscoveryTxn>();
  for (const m of payload.merchants) for (const t of m.txns) byOrdinal.set(t.n, t);

  const claimed = new Set<number>();
  const rows: any[] = [];
  const outcomes: ProposalOutcome[] = [];

  for (const p of submission.proposals) {
    const unknown = p.ordinals.filter((o) => !byOrdinal.has(o));
    if (unknown.length > 0) {
      outcomes.push({ label: p.label, stored: false, reason: `unknown ordinals: ${unknown.join(", ")}` });
      continue;
    }
    const overlap = p.ordinals.filter((o) => claimed.has(o));
    if (overlap.length > 0) {
      outcomes.push({
        label: p.label,
        stored: false,
        reason: `ordinals already claimed by another proposal: ${overlap.join(", ")}`,
      });
      continue;
    }
    const unique = [...new Set(p.ordinals)];
    const score = scoreCluster(
      unique.map((o) => {
        const t = byOrdinal.get(o)!;
        return { amount: t.amount, transacted_at: t.d };
      }),
      now,
    );
    if (!score) {
      outcomes.push({
        label: p.label,
        stored: false,
        reason: "these transactions do not recur on a schedule",
      });
      continue;
    }
    unique.forEach((o) => claimed.add(o));
    rows.push({ ...score, label: p.label, rationale: p.rationale, ordinals: unique });
    outcomes.push({ label: p.label, stored: true });
  }

  return { rows, outcomes };
}

export async function storeProposals(
  userId: string,
  windowMonths: number,
  submission: ProposalSubmission,
): Promise<{ stored: number; outcomes: ProposalOutcome[] }> {
  const { payload, idByOrdinal } = await buildDiscovery(userId, windowMonths);
  const { rows, outcomes } = resolveProposals(payload, submission, new Date());
  if (rows.length === 0) return { stored: 0, outcomes };

  const insert = rows.map((r) => ({
    user_id: userId,
    label: r.label,
    cadence: r.cadence,
    median_amount: r.median_amount,
    amount_min: r.amount_min,
    amount_max: r.amount_max,
    monthly_normalized: r.monthly_normalized,
    occurrences: r.occurrences,
    median_gap_days: r.median_gap_days,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    predicted_next: r.predicted_next,
    confidence: r.confidence,
    rationale: r.rationale,
    transaction_ids: r.ordinals.map((o: number) => idByOrdinal.get(o)).filter(Boolean),
    model: submission.model,
  }));

  const { error } = await supabase.from("subscription_proposals").insert(insert);
  if (error) throw new Error(`subscription_proposals insert failed: ${error.message}`);

  console.log(`[discovery] stored ${insert.length} proposal(s) for ${userId} via ${submission.model}`);
  return { stored: insert.length, outcomes };
}
