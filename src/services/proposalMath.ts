/**
 * Scores a cluster of transactions the agent has grouped into one proposed
 * subscription. The agent decides only which rows belong together; every figure
 * below — cadence, amount, next due — is computed here from those rows, so a
 * proposal can never carry a number the agent invented.
 *
 * Ported from the frontend's subscriptionDetect scoring so a proposal and a
 * client-detected candidate describe the same thing the same way.
 */

const DAY_MS = 86_400_000;

const CADENCES: { name: Cadence; center: number; tol: number }[] = [
  { name: "weekly", center: 7, tol: 2 },
  { name: "monthly", center: 30, tol: 7 },
  { name: "quarterly", center: 91, tol: 12 },
  { name: "annual", center: 365, tol: 20 },
];

// A subscription recurs on a schedule. A shorter median gap is frequent
// discretionary spend or a same-day burst, never a bill.
const MIN_CADENCE_DAYS = 5;
const IRREGULAR_PENALTY = 0.4;

export type Cadence = "weekly" | "monthly" | "quarterly" | "annual" | "irregular";

export interface ClusterTxn {
  amount: number;
  transacted_at: string;
}

export interface ClusterScore {
  cadence: Cadence;
  median_gap_days: number;
  occurrences: number;
  median_amount: number;
  amount_min: number;
  amount_max: number;
  monthly_normalized: number;
  confidence: number;
  first_seen: string;
  last_seen: string;
  predicted_next: string;
}

const median = (sorted: number[]) => {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stddevPop = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Returns null when the rows are not a recurring shape at all — too few, or
 *  billed too often to be a subscription. The caller must refuse the proposal
 *  rather than store a cluster the arithmetic does not support. */
export function scoreCluster(rows: ClusterTxn[], now: Date): ClusterScore | null {
  if (rows.length < 3) return null;

  const times = rows.map((r) => +new Date(r.transacted_at)).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY_MS);

  const medianGap = median([...gaps].sort((a, b) => a - b));
  if (medianGap < MIN_CADENCE_DAYS) return null;

  const matched = CADENCES.find((c) => Math.abs(medianGap - c.center) <= c.tol);
  const cadence: Cadence = matched?.name ?? "irregular";
  const tol = matched ? matched.tol : 0.3 * medianGap;
  const regularity = gaps.filter((g) => Math.abs(g - medianGap) <= tol).length / gaps.length;
  const cadenceScore = matched ? regularity : regularity * IRREGULAR_PENALTY;

  const amounts = rows.map((r) => r.amount);
  const meanAmt = mean(amounts);
  // Median for the stored amount — one combined order poisons a mean. Mean
  // still drives stability scoring.
  const medianAmt = median([...amounts].sort((a, b) => a - b));
  const amountStability = meanAmt > 0 ? Math.max(0, 1 - stddevPop(amounts) / meanAmt) : 0;

  const lastSeenMs = times[times.length - 1];
  const overdue = (+now - lastSeenMs) / DAY_MS / medianGap;
  const recencyScore = overdue > 1.5 ? 0.2 : overdue > 1.0 ? 0.6 : 1;
  const countBonus = Math.min(rows.length / 6, 1);

  return {
    cadence,
    median_gap_days: Math.round(medianGap),
    occurrences: rows.length,
    median_amount: round2(medianAmt),
    amount_min: round2(Math.min(...amounts)),
    amount_max: round2(Math.max(...amounts)),
    monthly_normalized: round2((medianAmt * 30) / medianGap),
    confidence: round2(
      0.5 * cadenceScore + 0.25 * amountStability + 0.15 * recencyScore + 0.1 * countBonus,
    ),
    first_seen: day(times[0]),
    last_seen: day(lastSeenMs),
    predicted_next: day(lastSeenMs + medianGap * DAY_MS),
  };
}
