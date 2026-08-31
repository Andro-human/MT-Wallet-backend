import { createHash } from "node:crypto";
import { z } from "zod";
import { supabase } from "./supabase.js";

/**
 * The agent-facing monthly review pipeline. Code owns every number:
 * buildReviewPayload resolves transactions exactly like the frontend
 * (duplicate exclusion, refund netting on both sides, is_expense/is_income
 * gating, combined-view split: groups whole, categories ungrouped-only) and
 * hands the agent ordinal-tagged transactions. The agent only returns
 * label + ordinals; storeReview sums every group/slice from the referenced
 * ordinals and rejects the whole submission unless each item is covered
 * exactly once and every sum reconciles to the paisa.
 */

const TZ = "Asia/Kolkata";
const istDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const istDay = (iso: string) => istDate.format(new Date(iso));
const istYearMonth = (iso: string) => istDay(iso).slice(0, 7);
export const currentIstMonth = () => istDate.format(new Date()).slice(0, 7);

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PayloadTxn {
  n: number;
  d: string;
  merchant: string | null;
  note: string | null;
  amount: number;
  refunded?: number;
  /** Combine tag. Transactions the user has combined on the Activity page share
   *  one tag and are ONE purchase. Absent when the transaction stands alone.
   *  Without this the agent counts rows: August's review said "37 orders" for a
   *  set that was 30 once combining was applied. */
  c?: string;
}
export interface PayloadItem {
  key: string;
  kind: "group" | "category";
  name: string;
  slug: string | null;
  total: number;
  /** Digest of the rows behind this item. Covers every input the one-liner and
   *  the group labels read — membership, net amount, note, merchant, combine
   *  tag — so an edited note or a late refund reopens the item while an
   *  untouched category stays closed. Keyed on transaction id, not ordinal, so
   *  a transaction added elsewhere in the month does not invalidate it. */
  fingerprint: string;
  /** Resolved by code, exactly like a day's needs_summary: submit a grouping
   *  for this item if and only if this is true. Everything else is carried
   *  forward from what is already stored. */
  needs_regen: boolean;
  txns: PayloadTxn[];
}
export interface PayloadDay {
  day: string;
  total: number;
  /** Every counted expense that day carries a note. A summary written from a
   *  partly-noted day describes the noted half and misrepresents the rest. */
  all_noted: boolean;
  /** Digest of the day's notes. Changes when a note is edited, which is the
   *  signal to rewrite a day already summarised. Keyed on transaction id, not
   *  ordinal, so inserting an earlier transaction does not invalidate it. */
  notes_fingerprint: string;
  /** A summary already exists for this day. */
  has_summary: boolean;
  /** Stored summary was written against different notes: a note was edited, a
   *  transaction arrived, or a refund changed the day's total. */
  summary_stale: boolean;
  /** Hand-authored. Never overwrite; storeReview refuses these anyway. */
  summary_locked: boolean;
  /** The whole decision, resolved by code so the agent does not have to reason
   *  about fingerprints: write this day if and only if this is true. */
  needs_summary: boolean;
  txns: PayloadTxn[];
}
export interface ReviewPayload {
  month: string;
  timezone: string;
  totals: { spent: number; income: number };
  items: PayloadItem[];
  days: PayloadDay[];
  income_lines: { d: string; merchant: string | null; note: string | null; amount: number }[];
  excluded: { duplicates: number; fullyRefunded: number; notCounted: number };
  known_slice_labels: string[];
  known_group_labels: string[];
}

async function fetchAll<T>(
  table: string,
  columns: string,
  filter: (q: any) => any = (q) => q,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filter(
      supabase.from(table).select(columns).order("id", { ascending: true }),
    ).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// Separator and truncation length are load-bearing: changing either invalidates
// every stored day fingerprint and rewrites months of settled summaries.
const digest = (keys: string[]) =>
  createHash("sha256").update([...keys].sort().join("\u0000")).digest("hex").slice(0, 16);

/** Identity of a breakdown across regenerations: the group key for grouped
 *  spend, the category slug otherwise. Matches what storeReview writes as
 *  `category`, which is how a stored breakdown finds its payload item again. */
export function breakdownKey(item: Pick<PayloadItem, "kind" | "key" | "slug">): string {
  return item.kind === "group" ? item.key : (item.slug ?? "uncategorized");
}

export interface StoredBreakdown {
  category: string | null;
  name: string;
  total: number;
  one_liner: string | null;
  groups: { label: string; amount: number; count: number }[];
  reconciled?: boolean;
  fingerprint?: string | null;
}

export interface StoredDay {
  notes_fingerprint: string | null;
  model: string | null;
}

export interface DaySummaryStatus {
  has_summary: boolean;
  summary_stale: boolean;
  summary_locked: boolean;
  needs_summary: boolean;
}

/** Whether the agent should write this day. Backfill and staleness live here so
 *  the agent never reasons about fingerprints: a day is written when it is fully
 *  noted, not hand-authored, and either has no summary yet or was summarised
 *  against different notes. That second case is what lets a late refund or an
 *  edited note reopen a day that was already done. */
/** Whether a transaction counts as noted for the purposes of writing a day.
 *
 *  A combined purchase carries its note on one row: the food order has it, the
 *  delivery fee billed seconds later does not. Judging each row alone marked the
 *  fee unnoted and blocked the whole day, which is why 26 Aug never got a
 *  summary despite the only real purchase being described.
 */
export function isEffectivelyNoted(
  note: string,
  combineTag: string | undefined,
  notedCombineTags: Set<string>,
): boolean {
  if (note) return true;
  return !!combineTag && notedCombineTags.has(combineTag);
}

export function daySummaryStatus(
  allNoted: boolean,
  fingerprint: string,
  stored: StoredDay | undefined,
): DaySummaryStatus {
  const has_summary = !!stored;
  const summary_locked = stored?.model === "manual";
  const summary_stale = has_summary && stored?.notes_fingerprint !== fingerprint;
  return {
    has_summary,
    summary_stale,
    summary_locked,
    needs_summary: allNoted && !summary_locked && (!has_summary || summary_stale),
  };
}

export async function loadStoredBreakdowns(userId: string, month: string): Promise<StoredBreakdown[]> {
  const { data, error } = await supabase
    .from("monthly_summaries")
    .select("category_breakdowns")
    .eq("user_id", userId)
    .eq("month", month)
    .maybeSingle();
  if (error) throw new Error(`monthly_summaries: ${error.message}`);
  return (data?.category_breakdowns as StoredBreakdown[]) ?? [];
}

export async function buildReviewPayload(userId: string, month: string): Promise<ReviewPayload> {
  const [y, m] = month.split("-").map(Number);
  // Padded UTC window so IST month-edge transactions are never missed.
  const windowStart = new Date(Date.UTC(y, m - 1, 1) - 36 * 3600 * 1000).toISOString();
  const windowEnd = new Date(Date.UTC(y, m, 1) + 36 * 3600 * 1000).toISOString();
  // Half-open, because `${month}-31` is not a date in a 30-day month and
  // Postgres rejects the whole query rather than clamping it.
  const nextMonthFirst = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);

  const [
    txnsRaw,
    refundLinks,
    duplicateLinks,
    combinedRows,
    categories,
    groups,
    existingDays,
    priorSummaries,
    storedBreakdowns,
  ] = await Promise.all([
      fetchAll<any>(
        "transactions",
        "id, amount, merchant, notes, transacted_at, direction, is_expense, is_income, category_id, group_id",
        (q) => q.eq("user_id", userId).gte("transacted_at", windowStart).lte("transacted_at", windowEnd),
      ),
      fetchAll<any>("refund_links", "original_transaction_id, refund_transaction_id, linked_amount", (q) =>
        q.eq("user_id", userId),
      ),
      fetchAll<any>("duplicate_links", "duplicate_transaction_id", (q) => q.eq("user_id", userId)),
      fetchAll<any>("combined_transactions", "combine_id, transaction_id", (q) =>
        q.eq("user_id", userId),
      ),
      fetchAll<any>("categories", "id, name, slug", (q) =>
        q.or(`is_system.eq.true,user_id.eq.${userId}`),
      ),
      fetchAll<any>("transaction_groups", "id, name", (q) => q.eq("user_id", userId)),
      fetchAll<any>("day_summaries", "day, notes_fingerprint, model", (q) =>
        q.eq("user_id", userId).gte("day", `${month}-01`).lt("day", nextMonthFirst),
      ),
      supabase
        .from("monthly_summaries")
        .select("month, spend_slices, category_breakdowns")
        .eq("user_id", userId)
        .neq("month", month)
        .order("month", { ascending: false })
        // The whole vocabulary, not a recent window. Seventy labels is under a
        // kilobyte of prompt; a six-month window hid `Travel bookings` from the
        // month that then coined `Trip bookings` for the same thing.
        .limit(24)
        .then(({ data, error }) => {
          if (error) throw new Error(`monthly_summaries: ${error.message}`);
          return data ?? [];
        }),
      loadStoredBreakdowns(userId, month),
    ]);

  // Short, stable per-payload tags so the agent can see which rows are one
  // purchase without carrying uuids around.
  const combineTag = new Map<string, string>();
  {
    const seen = new Map<string, string>();
    for (const r of combinedRows as { combine_id: string; transaction_id: string }[]) {
      let tag = seen.get(r.combine_id);
      if (!tag) {
        tag = `c${seen.size + 1}`;
        seen.set(r.combine_id, tag);
      }
      combineTag.set(r.transaction_id, tag);
    }
  }

  const notedCombineTags = new Set<string>();
  for (const t of txnsRaw as any[]) {
    const tag = combineTag.get(t.id);
    if (tag && (t.notes ?? "").trim()) notedCombineTags.add(tag);
  }

  const refundTotals: Record<string, number> = {};
  const refundAllocations: Record<string, number> = {};
  for (const l of refundLinks) {
    const amt = Number(l.linked_amount ?? 0);
    if (!amt) continue;
    refundTotals[l.original_transaction_id] = (refundTotals[l.original_transaction_id] || 0) + amt;
    refundAllocations[l.refund_transaction_id] = (refundAllocations[l.refund_transaction_id] || 0) + amt;
  }
  const duplicateExcludeIds = new Set(duplicateLinks.map((l: any) => l.duplicate_transaction_id));
  const catById = new Map(categories.map((c: any) => [c.id, c]));
  const groupById = new Map(groups.map((g: any) => [g.id, g]));

  const itemsByKey = new Map<string, Omit<PayloadItem, "fingerprint" | "needs_regen">>();
  const itemKeys = new Map<string, string[]>();
  const dayAcc = new Map<string, { total: number; txns: PayloadTxn[]; noteKeys: string[]; allNoted: boolean }>();
  const incomeLines: ReviewPayload["income_lines"] = [];
  const excluded = { duplicates: 0, fullyRefunded: 0, notCounted: 0 };
  let totalSpent = 0;
  let totalIncome = 0;
  let n = 0;

  for (const t of txnsRaw) {
    if (istYearMonth(t.transacted_at) !== month) continue;
    if (duplicateExcludeIds.has(t.id)) {
      excluded.duplicates++;
      continue;
    }
    const amount = Number(t.amount);

    if (t.is_income) {
      const net = round2(Math.max(amount - (refundAllocations[t.id] ?? 0), 0));
      if (net > 0) {
        totalIncome = round2(totalIncome + net);
        incomeLines.push({ d: istDay(t.transacted_at), merchant: t.merchant, note: t.notes, amount: net });
      }
    }

    if (!t.is_expense) {
      if (!t.is_income) excluded.notCounted++;
      continue;
    }

    const net = round2(Math.max(amount - (refundTotals[t.id] ?? 0), 0));
    if (net <= 0) {
      excluded.fullyRefunded++;
      continue;
    }
    totalSpent = round2(totalSpent + net);

    let key: string, kind: "group" | "category", name: string, slug: string | null;
    if (t.group_id) {
      key = `group:${t.group_id}`;
      kind = "group";
      name = groupById.get(t.group_id)?.name ?? "Unknown Group";
      slug = null;
    } else {
      const cat = t.category_id ? catById.get(t.category_id) : null;
      key = `cat:${t.category_id ?? "uncategorized"}`;
      kind = "category";
      name = cat?.name ?? "Uncategorized";
      slug = cat?.slug ?? "uncategorized";
    }

    const item = itemsByKey.get(key) ?? { key, kind, name, slug, total: 0, txns: [] };
    n += 1;
    item.txns.push({
      n,
      d: istDay(t.transacted_at),
      merchant: t.merchant ?? null,
      note: t.notes ?? null,
      amount: net,
      ...(refundTotals[t.id] ? { refunded: round2(refundTotals[t.id]) } : {}),
      ...(combineTag.has(t.id) ? { c: combineTag.get(t.id)! } : {}),
    });
    item.total = round2(item.total + net);
    itemsByKey.set(key, item);

    const note = (t.notes ?? "").trim();
    const keys = itemKeys.get(key) ?? [];
    keys.push(`${t.id}:${net}:${t.merchant ?? ""}:${combineTag.get(t.id) ?? ""}:${note}`);
    itemKeys.set(key, keys);

    const dayKey = istDay(t.transacted_at);
    const day = dayAcc.get(dayKey) ?? { total: 0, txns: [], noteKeys: [], allNoted: true };
    day.total = round2(day.total + net);
    day.txns.push({
      n,
      d: dayKey,
      merchant: t.merchant ?? null,
      note: t.notes ?? null,
      amount: net,
      ...(combineTag.has(t.id) ? { c: combineTag.get(t.id)! } : {}),
    });
    day.noteKeys.push(`${t.id}:${note}`);
    if (!isEffectivelyNoted(note, combineTag.get(t.id), notedCombineTags)) {
      day.allNoted = false;
    }
    dayAcc.set(dayKey, day);
  }

  const storedDays = new Map<string, { notes_fingerprint: string | null; model: string | null }>(
    (existingDays as any[]).map((r) => [r.day, { notes_fingerprint: r.notes_fingerprint, model: r.model }]),
  );

  const sliceLabels = new Set<string>();
  const groupLabels = new Set<string>();
  for (const s of priorSummaries as any[]) {
    for (const sl of s.spend_slices ?? []) sliceLabels.add(sl.label);
    for (const b of s.category_breakdowns ?? []) for (const g of b.groups ?? []) groupLabels.add(g.label);
  }

  const storedFingerprints = new Map(
    storedBreakdowns.map((b) => [b.category ?? "", b.fingerprint ?? null]),
  );

  return {
    month,
    timezone: TZ,
    totals: { spent: totalSpent, income: totalIncome },
    items: [...itemsByKey.values()]
      .sort((a, b) => b.total - a.total)
      .map((item) => {
        const fingerprint = digest(itemKeys.get(item.key) ?? []);
        return {
          ...item,
          fingerprint,
          needs_regen: storedFingerprints.get(breakdownKey(item)) !== fingerprint,
        };
      }),
    days: [...dayAcc.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, d]) => {
        const fingerprint = digest(d.noteKeys);
        return {
          day,
          total: d.total,
          all_noted: d.allNoted,
          notes_fingerprint: fingerprint,
          ...daySummaryStatus(d.allNoted, fingerprint, storedDays.get(day)),
          txns: d.txns,
        };
      }),
    income_lines: incomeLines.sort((a, b) => b.amount - a.amount),
    excluded,
    known_slice_labels: [...sliceLabels].sort(),
    known_group_labels: [...groupLabels].sort(),
  };
}

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const GroupingSchema = z.object({
  label: z.string().min(1).max(120),
  ordinals: z.array(z.number().int()).min(1).max(2000),
});
/** A slice says where a theme's money actually went, at the granularity of the
 *  things bought. The wedge in "Where it went" is the label; this is the line
 *  under it. Every figure in it is checked against the transactions the slice
 *  names, so the prose is the agent's and the arithmetic still is not. */
const SliceSchema = GroupingSchema.extend({
  one_liner: z.string().max(300).nullable().default(null),
});
export const ReviewSubmissionSchema = z.object({
  month: z.string().regex(MONTH_RE),
  /** Declares this as the catch-up run, the only caller allowed to write a month
   *  that has already ended. Nothing else stops run 1 from regenerating July if
   *  it decides July looks wrong, and a guarantee that lives only in a prompt is
   *  not a guarantee. */
  catch_up: z.boolean().default(false),
  review: z.object({
    highlights: z.array(z.string().min(1).max(500)).min(2).max(8),
    model: z.string().max(80).default("gemini-spark"),
  }),
  items: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        one_liner: z.string().max(300).nullable().default(null),
        groups: z.array(GroupingSchema).min(1).max(60),
      }),
    )
    .max(200)
    .default([]),
  slices: z.array(SliceSchema).max(60).default([]),
  days: z
    .array(
      z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        summary: z.string().min(1).max(400),
        groups: z.array(GroupingSchema).min(1).max(30),
      }),
    )
    .max(31)
    .default([]),
});
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

interface ReconciledGroup {
  label: string;
  amount: number;
  count: number;
  /** Slices only. Present but null means "checked, nothing to say"; absent means
   *  the row predates slice one-liners, which is what marks a month stale. */
  one_liner?: string | null;
}

// Caps the error list so a pathological submission (millions of foreign
// ordinals) can't amplify into an unbounded response.
const MAX_ERRORS = 50;
function pushError(errors: string[], msg: string) {
  if (errors.length < MAX_ERRORS) errors.push(msg);
  else if (errors.length === MAX_ERRORS) errors.push("(further errors truncated)");
}

export function reconcilePartition(
  scope: string,
  txnsByN: Map<number, number>,
  groups: { label: string; ordinals: number[]; one_liner?: string | null }[],
  expectedTotal: number,
  errors: string[],
): ReconciledGroup[] {
  const seen = new Set<number>();
  const out: ReconciledGroup[] = [];
  for (const g of groups) {
    let sum = 0;
    let count = 0;
    for (const o of g.ordinals) {
      if (!txnsByN.has(o)) {
        pushError(errors, `${scope}: ordinal ${o} in "${g.label}" is not in scope`);
        continue;
      }
      if (seen.has(o)) {
        pushError(errors, `${scope}: ordinal ${o} assigned twice`);
        continue;
      }
      seen.add(o);
      sum = round2(sum + txnsByN.get(o)!);
      count++;
    }
    if (count > 0) {
      out.push({
        label: g.label,
        amount: round2(sum),
        count,
        ...(g.one_liner !== undefined && { one_liner: g.one_liner }),
      });
    }
  }
  if (seen.size !== txnsByN.size) {
    const missing = [...txnsByN.keys()].filter((k) => !seen.has(k));
    pushError(errors, `${scope}: ordinals not covered: ${missing.join(", ")}`);
  }
  const total = round2(out.reduce((s, g) => s + g.amount, 0));
  if (Math.abs(total - expectedTotal) >= 0.01) {
    pushError(errors, `${scope}: group sum ₹${total} != expected total ₹${expectedTotal}`);
  }
  return out.sort((a, b) => b.amount - a.amount);
}

export interface ReconciledDay {
  day: string;
  summary: string;
  groups: ReconciledGroup[];
  notes_fingerprint: string;
}

/** Every rupee figure the agent writes must be one the server just computed:
 *  a group total, a single transaction, or the day total. Prose is the agent's,
 *  arithmetic is not. */
const MONEY_RE = /(?:₹|Rs\.?\s?)\s?([\d,]+(?:\.\d{1,2})?)/g;
export function verifyFigures(
  scope: string,
  summary: string,
  allowed: number[],
  errors: string[],
): void {
  for (const m of summary.matchAll(MONEY_RE)) {
    const claimed = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(claimed)) continue;
    if (!allowed.some((a) => Math.abs(a - claimed) < 0.01)) {
      pushError(errors, `${scope}: ₹${m[1]} in the summary is not a group total, a transaction, or the day total`);
    }
  }
}

/** Prose the agent wrote, returned only if every rupee in it is one the server
 *  computed. Otherwise null and a warning: a line is worth less than a month. */
export function checkedProse(
  scope: string,
  prose: string | null,
  allowed: number[],
  warnings: string[],
): string | null {
  if (!prose) return null;
  const bad: string[] = [];
  verifyFigures(scope, prose, allowed, bad);
  if (bad.length === 0) return prose;
  warnings.push(`${scope}: dropped, ${bad[0]}`);
  return null;
}

/** The month's own totals are not an insight. They are printed at the top of the
 *  page, in the stat strip, and on the dashboard; restating them spends the
 *  first and most-read line of the review on a number the reader already has.
 *  Enforced here rather than asked for in the prompt, because the agent
 *  reproduced it every month for five months running.
 */
export function totalsInHighlights(
  highlights: string[],
  spent: number,
  income: number,
): { highlight: string; figure: number }[] {
  const forbidden = [spent, income].filter((n) => n > 0);
  const hits: { highlight: string; figure: number }[] = [];
  for (const h of highlights) {
    for (const m of h.matchAll(MONEY_RE)) {
      const claimed = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(claimed)) continue;
      const hit = forbidden.find((f) => Math.abs(f - claimed) < 0.01);
      if (hit !== undefined) hits.push({ highlight: h, figure: hit });
    }
  }
  return hits;
}

export function reconcileDays(
  payload: ReviewPayload,
  submission: ReviewSubmission,
  errors: string[],
): ReconciledDay[] {
  // Tolerate a payload or submission built before days existed rather than
  // throwing: a missing day list means "no day summaries", not an error.
  const byDay = new Map((payload.days ?? []).map((d) => [d.day, d]));
  const out: ReconciledDay[] = [];

  for (const sub of submission.days ?? []) {
    const day = byDay.get(sub.day);
    if (!day) {
      pushError(errors, `day ${sub.day}: not in this month's payload`);
      continue;
    }
    if (!day.all_noted) {
      pushError(errors, `day ${sub.day}: not every transaction is noted, so it must be left without a summary`);
      continue;
    }
    const byN = new Map(day.txns.map((t) => [t.n, t.amount]));
    const before = errors.length;
    const groups = reconcilePartition(`day ${sub.day}`, byN, sub.groups, day.total, errors);
    verifyFigures(
      `day ${sub.day}`,
      sub.summary,
      [...groups.map((g) => g.amount), ...day.txns.map((t) => t.amount), day.total],
      errors,
    );
    if (errors.length > before) continue;
    out.push({ day: sub.day, summary: sub.summary, groups, notes_fingerprint: day.notes_fingerprint });
  }
  return out;
}

export interface ReconciledSubmission {
  errors: string[];
  /** Prose the server refused to store, having found a figure in it that it
   *  never computed. Dropping the sentence loses a line; erroring would lose
   *  the month, and a bad one-liner is not worth a month. */
  warnings: string[];
  breakdowns: {
    category: string | null;
    name: string;
    total: number;
    one_liner: string | null;
    groups: ReconciledGroup[];
    reconciled: boolean;
    fingerprint: string;
  }[];
  /** How many breakdowns came from storage rather than this submission. */
  carried: number;
  slices: ReconciledGroup[];
  days: ReconciledDay[];
}

/**
 * Pure reconciliation: every payload item must be accounted for — either
 * partitioned by this submission or carried forward unchanged from `stored` —
 * every submitted key must exist, and sums must match to the paisa. Any
 * violation lands in `errors` — the caller must not store when errors exist.
 *
 * An item may only be carried forward when the payload marked it needs_regen
 * false, which means its fingerprint still matches what produced the stored
 * groups. Anything the agent left out and code considers changed is an error,
 * not a silent carry-over.
 */
export function reconcileSubmission(
  payload: ReviewPayload,
  submission: ReviewSubmission,
  stored: StoredBreakdown[] = [],
  currentMonth: string = currentIstMonth(),
): ReconciledSubmission {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (payload.month !== currentMonth && !submission.catch_up) {
    pushError(
      errors,
      `${payload.month} has ended: only the catch-up run may rewrite it, and it must say so with catch_up`,
    );
  }

  const submittedByKey = new Map(submission.items.map((i) => [i.key, i]));
  if (submittedByKey.size !== submission.items.length) {
    const counts = new Map<string, number>();
    for (const i of submission.items) counts.set(i.key, (counts.get(i.key) ?? 0) + 1);
    const dups = [...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k);
    pushError(errors, `duplicate item keys in submission: ${dups.join(", ")}`);
  }
  for (const i of submission.items) {
    if (!payload.items.some((p) => p.key === i.key)) pushError(errors, `unknown item key ${i.key}`);
  }

  const storedByKey = new Map(stored.map((b) => [b.category ?? "", b]));
  const breakdowns: ReconciledSubmission["breakdowns"] = [];
  let carried = 0;
  for (const item of payload.items) {
    const sub = submittedByKey.get(item.key);
    if (!sub) {
      const prior = storedByKey.get(breakdownKey(item));
      if (item.needs_regen || !prior) {
        pushError(errors, `${item.name} (${item.key}): no grouping submitted`);
        continue;
      }
      if (Math.abs(prior.total - item.total) >= 0.01) {
        pushError(
          errors,
          `${item.name} (${item.key}): stored breakdown totals ₹${prior.total} but the month now holds ₹${item.total}`,
        );
        continue;
      }
      carried++;
      breakdowns.push({
        category: item.kind === "group" ? item.key : item.slug,
        // A renamed category should show its new name without forcing the agent
        // to rewrite groups that did not change.
        name: item.name,
        total: round2(item.total),
        one_liner: prior.one_liner,
        groups: prior.groups,
        reconciled: true,
        fingerprint: item.fingerprint,
      });
      continue;
    }
    const byN = new Map(item.txns.map((t) => [t.n, t.amount]));
    const groups = reconcilePartition(item.name, byN, sub.groups, item.total, errors);
    const oneLiner = checkedProse(
      `${item.name} one-liner`,
      sub.one_liner,
      [...groups.map((g) => g.amount), ...item.txns.map((t) => t.amount), round2(item.total)],
      warnings,
    );
    breakdowns.push({
      category: item.kind === "group" ? item.key : item.slug,
      name: item.name,
      total: round2(item.total),
      one_liner: oneLiner,
      groups,
      reconciled: true,
      fingerprint: item.fingerprint,
    });
  }

  let slices: ReconciledGroup[] = [];
  if (submission.slices.length > 0) {
    const allByN = new Map(payload.items.flatMap((it) => it.txns.map((t) => [t.n, t.amount] as const)));
    slices = reconcilePartition("slices", allByN, submission.slices, payload.totals.spent, errors);
    // A slice line may name the things bought or the slice's own total. It may
    // not name a subtotal of its own invention, because nothing computed one.
    const submittedByLabel = new Map(submission.slices.map((sl) => [sl.label, sl]));
    slices = slices.map((sl) => {
      const sub = submittedByLabel.get(sl.label);
      if (!sub) return sl;
      const allowed = [
        ...sub.ordinals.map((o) => allByN.get(o)).filter((a): a is number => a !== undefined),
        sl.amount,
      ];
      return { ...sl, one_liner: checkedProse(`slice "${sl.label}"`, sl.one_liner ?? null, allowed, warnings) };
    });
  }

  for (const hit of totalsInHighlights(
    submission.review.highlights,
    payload.totals.spent,
    payload.totals.income,
  )) {
    pushError(
      errors,
      `highlight restates a month total (\u20b9${hit.figure}), which the page already shows: "${hit.highlight}"`,
    );
  }

  const days = reconcileDays(payload, submission, errors);

  return { errors, warnings, breakdowns, carried, slices, days };
}

/**
 * Reconcile a submission against a freshly built payload and store it.
 * Returns { errors } on any violation — nothing is written.
 */
export async function storeReview(
  userId: string,
  payload: ReviewPayload,
  submission: ReviewSubmission,
): Promise<
  | { errors: string[] }
  | { stored: true; warnings: string[]; items: number; carried: number; slices: number; days: number }
> {
  const { data: priorRow } = await supabase
    .from("monthly_summaries")
    .select("spend_slices, category_breakdowns")
    .eq("user_id", userId)
    .eq("month", payload.month)
    .maybeSingle();

  const { errors, warnings, breakdowns, carried, slices, days } = reconcileSubmission(
    payload,
    submission,
    (priorRow?.category_breakdowns as StoredBreakdown[]) ?? [],
  );
  if (errors.length > 0) return { errors };

  // A submission without slices means "no slice update", not "clear them" —
  // keep whatever the month already has stored.
  const storedSlices: ReconciledGroup[] =
    submission.slices.length > 0 ? slices : ((priorRow?.spend_slices as ReconciledGroup[]) ?? []);

  const aggregates = {
    month: payload.month,
    total_spent: Math.round(payload.totals.spent),
    total_income: Math.round(payload.totals.income),
    allocations: payload.items
      .slice(0, 10)
      .map((i) => ({ name: i.name, amount: Math.round(i.total), type: i.kind })),
    top_sub_themes: breakdowns
      .flatMap((b) => b.groups.map((g) => ({ context: b.name, label: g.label, amount: Math.round(g.amount) })))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10),
    recurring_monthly_committed: null,
    loans_outstanding: null,
  };

  const { error } = await supabase.from("monthly_summaries").upsert({
    user_id: userId,
    month: payload.month,
    highlights: submission.review.highlights,
    aggregates,
    category_breakdowns: breakdowns,
    spend_slices: storedSlices,
    usage: { input: 0, output: 0, reasoning: 0 },
    model: submission.review.model,
    generated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`summary upsert failed: ${error.message}`);

  // Never overwrite a hand-authored line. Those were written as the reference
  // voice, so the agent has to be asked explicitly to replace one.
  if (days.length > 0) {
    const { data: manual } = await supabase
      .from("day_summaries")
      .select("day")
      .eq("user_id", userId)
      .eq("model", "manual")
      .in("day", days.map((d) => d.day));
    const protectedDays = new Set((manual ?? []).map((r: any) => r.day));

    const rows = days
      .filter((d) => !protectedDays.has(d.day))
      .map((d) => ({
        user_id: userId,
        day: d.day,
        summary: d.summary,
        notes_fingerprint: d.notes_fingerprint,
        model: submission.review.model,
        generated_at: new Date().toISOString(),
      }));

    if (rows.length > 0) {
      const { error: dayError } = await supabase
        .from("day_summaries")
        .upsert(rows, { onConflict: "user_id,day" });
      if (dayError) throw new Error(`day_summaries upsert failed: ${dayError.message}`);
    }
    if (protectedDays.size > 0) {
      console.log(`[review] skipped ${protectedDays.size} hand-written day(s): ${[...protectedDays].join(", ")}`);
    }
  }

  console.log(
    `[review] stored ${payload.month} for ${userId} via ${submission.review.model}: ` +
      `${breakdowns.length} items (${carried} carried), ` +
      `${storedSlices.length} slices${submission.slices.length === 0 ? " (carried over)" : ""}, ${days.length} days`,
  );
  if (warnings.length > 0) console.log(`[review] ${payload.month}: ${warnings.join("; ")}`);
  return {
    stored: true,
    warnings,
    items: breakdowns.length,
    carried,
    slices: storedSlices.length,
    days: days.length,
  };
}
