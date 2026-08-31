import {
  buildReviewPayload,
  currentIstMonth,
  totalsInHighlights,
  type ReviewPayload,
} from "./monthlyReview.js";
import { supabase } from "./supabase.js";

/**
 * Which past months still have work in them. Run 1 only ever looks at the
 * current month, so a refund landing in August silently falsifies July's
 * review — the AirPods purchase stayed the month's biggest line long after it
 * had been refunded to nothing.
 *
 * Staleness is not a separate calculation: the payload already resolves it per
 * item and per day against stored fingerprints. This walks the window and asks.
 */

export interface MonthStatus {
  month: string;
  has_review: boolean;
  items_stale: number;
  items_total: number;
  days_stale: number;
  /** The stored highlights break a rule the server now enforces. Highlights are
   *  rewritten in full on any submission, so a month in this state needs only
   *  the highlights resubmitted, not its categories regrouped. */
  highlights_stale: boolean;
  /** Stored slices predate slice one-liners. Absent is the signal, not null:
   *  null is a checked "nothing to say" and must not requeue the month forever. */
  slices_stale: boolean;
  needs_work: boolean;
}

export function monthsBefore(month: string, count: number): string[] {
  const [y, m] = month.split("-").map(Number);
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function statusOf(
  month: string,
  payload: ReviewPayload,
  hasReview: boolean,
  storedHighlights: string[] = [],
  storedSlices: { one_liner?: string | null }[] = [],
): MonthStatus {
  const items_stale = payload.items.filter((i) => i.needs_regen).length;
  const days_stale = payload.days.filter((d) => d.needs_summary).length;
  const highlights_stale =
    hasReview &&
    totalsInHighlights(storedHighlights, payload.totals.spent, payload.totals.income).length > 0;
  const slices_stale = storedSlices.length > 0 && storedSlices.some((s) => !("one_liner" in s));
  return {
    month,
    has_review: hasReview,
    items_stale,
    items_total: payload.items.length,
    days_stale,
    highlights_stale,
    slices_stale,
    // A month with no counted spend has nothing to write, review row or not.
    needs_work: items_stale > 0 || days_stale > 0 || highlights_stale || slices_stale,
  };
}

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
    }),
  );
  return out;
}

export interface StaleReport {
  window: string[];
  stale: MonthStatus[];
  /** Stale months the limit held back. Reported rather than dropped silently:
   *  a truncated list reads as "nothing else to do" when it is not. */
  deferred: number;
}

export async function findStaleMonths(
  userId: string,
  opts: { windowMonths?: number; limit?: number } = {},
): Promise<StaleReport> {
  const windowMonths = Math.min(Math.max(opts.windowMonths ?? 24, 1), 60);
  const limit = Math.min(Math.max(opts.limit ?? 3, 1), 12);
  const window = monthsBefore(currentIstMonth(), windowMonths);

  const { data: reviewed, error } = await supabase
    .from("monthly_summaries")
    .select("month, highlights, spend_slices")
    .eq("user_id", userId)
    .in("month", window);
  if (error) throw new Error(`monthly_summaries: ${error.message}`);
  const stored = new Map(
    (reviewed ?? []).map((r: { month: string; highlights: unknown; spend_slices: unknown }) => [
      r.month,
      {
        highlights: Array.isArray(r.highlights) ? (r.highlights as string[]) : [],
        slices: Array.isArray(r.spend_slices) ? (r.spend_slices as { one_liner?: string | null }[]) : [],
      },
    ]),
  );

  const statuses = await mapPool(window, 4, async (month) =>
    statusOf(
      month,
      await buildReviewPayload(userId, month),
      stored.has(month),
      stored.get(month)?.highlights ?? [],
      stored.get(month)?.slices ?? [],
    ),
  );

  const stale = statuses.filter((s) => s.needs_work);
  return { window, stale: stale.slice(0, limit), deferred: Math.max(stale.length - limit, 0) };
}
