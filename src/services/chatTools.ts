import { UNCATEGORIZED, type Ledger, type LedgerTxn } from "./spendLedger.js";
import type { Cadence } from "./proposalMath.js";
import {
  attributeTo,
  buildBudgetIndex,
  countOrders,
  monthlyCeiling,
  standingForMonth,
  type BudgetDef,
} from "./budgetMath.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** Thrown for bad tool input. The message goes back to the model verbatim so
 *  it can correct the call. */
export class ToolInputError extends Error {}

// ── Periods ───────────────────────────────────────────────────────────────────

export interface Period {
  from: string;
  to: string;
}

const PERIOD_RE = /^20\d{2}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const EARLIEST = "2000-01-01";

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function startOf(token: string): string {
  if (token.length === 4) return `${token}-01-01`;
  if (token.length === 7) return `${token}-01`;
  return token;
}

function endOf(token: string): string {
  if (token.length === 4) return `${token}-12-31`;
  if (token.length === 7) {
    const [y, m] = token.split("-").map(Number);
    return `${token}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
  }
  return token;
}

function checkBound(v: string | undefined) {
  if (v === undefined) return;
  const bad = () => new ToolInputError(`"${v}" is not a date. Use YYYY, YYYY-MM or YYYY-MM-DD (years 2000-2099).`);
  if (!PERIOD_RE.test(v)) throw bad();
  if (v.length === 10) {
    const [y, m, d] = v.split("-").map(Number);
    if (d > daysInMonth(y, m)) throw bad();
  }
}

/** Bounds are YYYY, YYYY-MM or YYYY-MM-DD, each covering its whole span and
 *  inclusive. from alone runs to today ("since"); to alone runs from the start
 *  of the data; neither is the current month to date. */
export function parsePeriod(from: string | undefined, to: string | undefined, today: string): Period {
  checkBound(from);
  checkBound(to);
  if (!from && !to) return { from: startOf(today.slice(0, 7)), to: today };
  const period = { from: from ? startOf(from) : EARLIEST, to: to ? endOf(to) : today };
  if (period.from > period.to) throw new ToolInputError(`from (${period.from}) is after to (${period.to}).`);
  return period;
}

/** A comparison period needs both ends; one alone would silently compare
 *  against "since X" or "up to X". */
export function parseCompare(from: string | undefined, to: string | undefined, today: string): Period | undefined {
  if (!from && !to) return undefined;
  if (!from || !to) {
    throw new ToolInputError("Pass both compare_from and compare_to, e.g. compare_from=\"2026-08\", compare_to=\"2026-08\".");
  }
  return parsePeriod(from, to, today);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
    m === 12 ? ((y += 1), (m = 1)) : (m += 1);
  }
  return out;
}

// ── Filters ───────────────────────────────────────────────────────────────────

export interface TxnFilter {
  category?: string;
  group?: string;
  text?: string;
  min_amount?: number;
  max_amount?: number;
  account?: string;
}

export type KindFilter = "expense" | "income" | "all";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Matched on slug, the same value a row is labelled with, so a row whose
 *  category was deleted reads and filters as Uncategorized alike. */
function resolveCategory(ledger: Ledger, wanted: string): Set<string> {
  const w = norm(wanted);
  const slugs = ledger.categories.filter((c) => norm(c.slug) === w || norm(c.name) === w).map((c) => c.slug);
  if (w === UNCATEGORIZED.slug) slugs.push(UNCATEGORIZED.slug);
  if (slugs.length === 0) {
    const known = [...new Set(ledger.categories.map((c) => c.name))].sort().join(", ");
    throw new ToolInputError(`No category "${wanted}". Known categories: ${known}.`);
  }
  return new Set(slugs);
}

function resolveGroup(ledger: Ledger, wanted: string): Set<string> {
  const w = norm(wanted);
  const ids = ledger.groups.filter((g) => norm(g.name) === w).map((g) => g.id);
  if (ids.length === 0) {
    const known = ledger.groups.map((g) => g.name).sort().join(", ");
    throw new ToolInputError(`No group "${wanted}". Known groups: ${known || "none"}.`);
  }
  return new Set(ids);
}

/** Net for rows that count, the face amount for the rest (a duplicate or a
 *  transfer has no net). Filters, sorting and output all use this. */
const shownAmount = (t: LedgerTxn) => (t.status === "counted" ? t.net : t.amount);

export function matcher(ledger: Ledger, filter: TxnFilter): (t: LedgerTxn) => boolean {
  const cats = filter.category ? resolveCategory(ledger, filter.category) : null;
  const groups = filter.group ? resolveGroup(ledger, filter.group) : null;
  const words = norm(filter.text).split(/\s+/).filter(Boolean);
  const account = norm(filter.account);
  return (t) => {
    if (cats && !cats.has(t.category_slug)) return false;
    if (groups && !(t.group_id && groups.has(t.group_id))) return false;
    if (account && !norm(t.account).includes(account)) return false;
    const amount = shownAmount(t);
    if (filter.min_amount !== undefined && amount < filter.min_amount) return false;
    if (filter.max_amount !== undefined && amount > filter.max_amount) return false;
    if (words.length) {
      const hay = [t.merchant, t.note, t.service, t.subscription, t.lending?.counterparty].map(norm).join(" ");
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  };
}

const inPeriod = (p: Period) => (t: LedgerTxn) => t.day >= p.from && t.day <= p.to;
const countedAs = (kind: KindFilter) => (t: LedgerTxn) =>
  t.status === "counted" && (kind === "all" || t.kind === kind);

function notIncluded(txns: LedgerTxn[]) {
  const out = { duplicates: 0, fully_refunded: 0, transfers_and_uncounted: 0 };
  for (const t of txns) {
    if (t.status === "duplicate") out.duplicates++;
    else if (t.status === "refunded") out.fully_refunded++;
    else if (t.status === "not_counted") out.transfers_and_uncounted++;
  }
  return out;
}

// ── spend_summary ─────────────────────────────────────────────────────────────

export type GroupBy = "category" | "group" | "merchant" | "account" | "month" | "week" | "day" | "none";
const TIME_GROUPINGS: GroupBy[] = ["month", "week", "day"];
const MAX_DAY_ROWS = 120;
const MAX_WEEK_ROWS = 530;

interface Bucket {
  key: string;
  labels: Map<string, number>;
  total: number;
  txns: LedgerTxn[];
}

function bucketKey(t: LedgerTxn, by: GroupBy): { key: string; label: string } {
  switch (by) {
    case "category":
      return { key: t.category_slug, label: t.category };
    case "group":
      return t.group_id ? { key: t.group_id, label: t.group! } : { key: "", label: "(not in a group)" };
    case "merchant": {
      const m = (t.merchant ?? "").trim();
      return m ? { key: m.toLowerCase(), label: m } : { key: "", label: "(no merchant)" };
    }
    case "account":
      return t.account ? { key: t.account, label: t.account } : { key: "", label: "(unknown account)" };
    case "month":
      return { key: t.month, label: t.month };
    case "week": {
      const w = weekStart(t.day);
      return { key: w, label: `week of ${w}` };
    }
    case "day":
      return { key: t.day, label: t.day };
    case "none":
      return { key: "all", label: "all" };
  }
}

function bucketize(txns: LedgerTxn[], by: GroupBy): Map<string, Bucket> {
  const out = new Map<string, Bucket>();
  for (const t of txns) {
    const { key, label } = bucketKey(t, by);
    const b: Bucket = out.get(key) ?? { key, labels: new Map(), total: 0, txns: [] };
    b.labels.set(label, (b.labels.get(label) ?? 0) + 1);
    b.total = round2(b.total + t.net);
    b.txns.push(t);
    out.set(key, b);
  }
  return out;
}

/** The spelling used most often, for a merchant typed several ways. */
const topLabel = (b: Bucket) => [...b.labels.entries()].sort((a, c) => c[1] - a[1])[0][0];

export interface SpendSummaryArgs {
  period: Period;
  group_by: GroupBy;
  kind: Exclude<KindFilter, "all">;
  filter: TxnFilter;
  compare?: Period;
  limit: number;
}

export function spendSummary(ledger: Ledger, args: SpendSummaryArgs) {
  const { period, group_by, kind, filter, compare, limit } = args;
  const isTime = TIME_GROUPINGS.includes(group_by);
  if (compare && isTime) {
    throw new ToolInputError(
      `compare_from/compare_to cannot be used with group_by="${group_by}". Group by month (or week) over a range that spans both periods instead.`,
    );
  }
  const spanDays = (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000 + 1;
  if (group_by === "day" && spanDays > MAX_DAY_ROWS) {
    throw new ToolInputError(`group_by="day" is limited to ${MAX_DAY_ROWS} days. Use week or month for longer ranges.`);
  }
  if (group_by === "week" && spanDays / 7 > MAX_WEEK_ROWS) {
    throw new ToolInputError(`group_by="week" is limited to about ten years. Use month for longer ranges.`);
  }

  const matches = matcher(ledger, filter);
  const select = (p: Period) => ledger.txns.filter((t) => inPeriod(p)(t) && matches(t));
  const inRange = select(period);
  const current = inRange.filter(countedAs(kind));
  const total = round2(current.reduce((s, t) => s + t.net, 0));
  const buckets = bucketize(current, group_by);

  if (isTime && group_by !== "day") {
    const keys =
      group_by === "month"
        ? monthsBetween(period.from, period.to)
        : (() => {
            const weeks: string[] = [];
            for (let w = weekStart(period.from); w <= period.to; w = addDays(w, 7)) weeks.push(w);
            return weeks;
          })();
    for (const k of keys) {
      if (!buckets.has(k)) {
        const label = group_by === "month" ? k : `week of ${k}`;
        buckets.set(k, { key: k, labels: new Map([[label, 1]]), total: 0, txns: [] });
      }
    }
  }

  const prevBuckets = compare ? bucketize(select(compare).filter(countedAs(kind)), group_by) : null;
  const prevTotal = prevBuckets ? round2([...prevBuckets.values()].reduce((s, b) => s + b.total, 0)) : null;

  const keys = new Set([...buckets.keys(), ...(prevBuckets?.keys() ?? [])]);
  let rows = [...keys].map((key) => {
    const b = buckets.get(key);
    const p = prevBuckets?.get(key);
    const amount = b?.total ?? 0;
    const row: Record<string, unknown> = {
      label: b ? topLabel(b) : topLabel(p!),
      total: amount,
      count: b?.txns.length ?? 0,
      orders: b ? countOrders(b.txns) : 0,
      share_pct: pct(amount, total),
    };
    if (prevBuckets) {
      const before = p?.total ?? 0;
      row.previous_total = before;
      row.change = round2(amount - before);
      row.change_pct = pct(amount - before, before);
    }
    return { key, sortBy: Math.max(amount, p?.total ?? 0), row };
  });

  rows = isTime ? rows.sort((a, b) => (a.key < b.key ? -1 : 1)) : rows.sort((a, b) => b.sortBy - a.sortBy);

  let folded: { rows: number; total: number } | undefined;
  if (!isTime && rows.length > limit) {
    const tail = rows.slice(limit);
    folded = { rows: tail.length, total: round2(tail.reduce((s, r) => s + (r.row.total as number), 0)) };
    rows = rows.slice(0, limit);
  }

  return {
    period,
    kind,
    group_by,
    total,
    count: current.length,
    orders: countOrders(current),
    ...(compare
      ? {
          compare_period: compare,
          compare_total: prevTotal,
          change: round2(total - prevTotal!),
          change_pct: pct(total - prevTotal!, prevTotal!),
        }
      : {}),
    rows: rows.map((r) => r.row),
    ...(folded ? { more_rows_folded: folded } : {}),
    not_included: notIncluded(inRange),
  };
}

// ── search_transactions ───────────────────────────────────────────────────────

export type SortOrder = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";

export function txnOut(t: LedgerTxn) {
  const out: Record<string, unknown> = {
    day: t.day,
    merchant: t.merchant,
    note: t.note,
    amount: shownAmount(t),
    kind: t.kind,
    category: t.category,
  };
  if (t.status !== "counted") out.status = t.status;
  if (t.refunded) out.refunded = t.refunded;
  if (t.refunded && t.status === "counted") out.gross = t.amount;
  if (t.group) out.group = t.group;
  if (t.combine) out.combined_purchase = t.combine;
  if (t.subscription) out.subscription = t.subscription;
  if (t.service) out.service = t.service;
  if (t.lending) out.lending = t.lending;
  if (t.budget_excluded) out.one_off = true;
  if (t.account) out.account = t.account;
  return out;
}

export interface SearchArgs {
  period: Period;
  filter: TxnFilter;
  kind: KindFilter;
  include_uncounted: boolean;
  sort: SortOrder;
  limit: number;
}

export function searchTransactions(ledger: Ledger, args: SearchArgs) {
  const matches = matcher(ledger, args.filter);
  const kindOk = (t: LedgerTxn) => args.kind === "all" || t.kind === args.kind;
  const all = ledger.txns.filter((t) => inPeriod(args.period)(t) && matches(t) && kindOk(t));
  const shown = args.include_uncounted ? all : all.filter((t) => t.status === "counted");

  const cmp: Record<SortOrder, (a: LedgerTxn, b: LedgerTxn) => number> = {
    date_desc: (a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0),
    date_asc: (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0),
    amount_desc: (a, b) => shownAmount(b) - shownAmount(a),
    amount_asc: (a, b) => shownAmount(a) - shownAmount(b),
  };
  const sorted = [...shown].sort(cmp[args.sort]);
  const counted = all.filter((t) => t.status === "counted");

  return {
    period: args.period,
    matched: shown.length,
    spent_total: round2(counted.filter((t) => t.kind === "expense").reduce((s, t) => s + t.net, 0)),
    income_total: round2(counted.filter((t) => t.kind === "income").reduce((s, t) => s + t.net, 0)),
    returned: Math.min(sorted.length, args.limit),
    ...(sorted.length > args.limit ? { truncated: true } : {}),
    ...(args.include_uncounted ? {} : { not_included: notIncluded(all) }),
    transactions: sorted.slice(0, args.limit).map(txnOut),
  };
}

// ── get_month_review ──────────────────────────────────────────────────────────

interface StoredGroup {
  label: string;
  amount: number;
  count: number;
  one_liner?: string | null;
  txn_ids?: string[];
  parts?: StoredGroup[];
}

export interface StoredMonthSummary {
  month: string;
  highlights: string[] | null;
  spend_slices: StoredGroup[] | null;
  category_breakdowns:
    | { name: string; total: number; one_liner: string | null; groups: StoredGroup[] }[]
    | null;
  generated_at: string | null;
}

const groupOut = (g: StoredGroup) => ({
  label: g.label,
  amount: g.amount,
  count: g.count,
  ...(g.one_liner ? { one_liner: g.one_liner } : {}),
  ...(g.parts?.length ? { parts: g.parts.map((p) => ({ label: p.label, amount: p.amount, count: p.count })) } : {}),
});

export function monthReview(
  ledger: Ledger,
  month: string,
  stored: StoredMonthSummary | null,
  days: { day: string; summary: string }[],
  expand?: string,
) {
  const monthTxns = ledger.txns.filter((t) => t.month === month && t.status === "counted");
  const live = {
    spent: round2(monthTxns.filter((t) => t.kind === "expense").reduce((s, t) => s + t.net, 0)),
    income: round2(monthTxns.filter((t) => t.kind === "income").reduce((s, t) => s + t.net, 0)),
  };

  if (!stored) {
    return {
      month,
      review: null,
      message: "No AI review has been generated for this month yet. Use spend_summary for its numbers.",
      live_totals: live,
      day_summaries: days,
    };
  }

  let expanded: Record<string, unknown> | undefined;
  if (expand) {
    const want = norm(expand);
    const candidates: StoredGroup[] = [
      ...(stored.spend_slices ?? []).flatMap((s) => [s, ...(s.parts ?? [])]),
      ...(stored.category_breakdowns ?? []).flatMap((b) => b.groups ?? []),
    ];
    const expandable = candidates.filter((g) => g.txn_ids?.length);
    const hit = expandable.find((g) => norm(g.label) === want);
    if (!hit) {
      if (candidates.some((g) => norm(g.label) === want)) {
        throw new ToolInputError(
          `"${expand}" in ${month} was stored without its transactions. Use search_transactions for that month instead.`,
        );
      }
      const labels = [...new Set(expandable.map((g) => g.label))].sort().join(", ");
      throw new ToolInputError(`No slice or group labelled "${expand}" in ${month}. Labels: ${labels}.`);
    }
    expanded = {
      label: hit.label,
      amount: hit.amount,
      transactions: hit.txn_ids!.map((id) => ledger.byId.get(id)).filter((t): t is LedgerTxn => !!t).map(txnOut),
    };
  }

  return {
    month,
    generated_at: stored.generated_at,
    live_totals: live,
    highlights: stored.highlights ?? [],
    slices: (stored.spend_slices ?? []).map(groupOut),
    categories: (stored.category_breakdowns ?? []).map((b) => ({
      name: b.name,
      total: b.total,
      ...(b.one_liner ? { one_liner: b.one_liner } : {}),
      groups: (b.groups ?? []).map(groupOut),
    })),
    day_summaries: days,
    ...(expanded ? { expanded } : {}),
  };
}

// ── budget_status ─────────────────────────────────────────────────────────────

/** Mirrors MT-Wallet useBudgetStandings: counted debits only, one-offs the user
 *  marked are reported but not charged, and every history month feeds carry. */
export function budgetStatus(ledger: Ledger, budgets: BudgetDef[], month: string, today: string) {
  if (budgets.length === 0) {
    return { month, budgets: [], message: "No budgets are set up." };
  }
  const index = buildBudgetIndex(budgets);
  const byBudgetMonth = new Map<string, Map<string, number>>();
  const byBudgetWeek = new Map<string, Map<string, LedgerTxn[]>>();
  let excluded = 0;
  let unbudgeted = 0;

  const [y, m] = month.split("-").map(Number);
  const monthEnd = endOf(month);
  const weekStarts: string[] = [];
  for (let w = weekStart(`${month}-01`); w <= monthEnd; w = addDays(w, 7)) weekStarts.push(w);
  const isCurrent = today.slice(0, 7) === month;
  const thisWeek = weekStart(today);
  const reportedWeeks = new Set([...weekStarts, thisWeek]);

  for (const t of ledger.txns) {
    if (t.status !== "counted" || t.kind !== "expense") continue;
    if (t.budget_excluded) {
      if (t.month === month) excluded = round2(excluded + t.net);
      continue;
    }
    const id = attributeTo(t, index);
    if (!id) {
      if (t.month === month) unbudgeted = round2(unbudgeted + t.net);
      continue;
    }
    const months = byBudgetMonth.get(id) ?? new Map<string, number>();
    months.set(t.month, round2((months.get(t.month) ?? 0) + t.net));
    byBudgetMonth.set(id, months);

    const w = weekStart(t.day);
    if (!reportedWeeks.has(w)) continue;
    let weeks = byBudgetWeek.get(id);
    if (!weeks) byBudgetWeek.set(id, (weeks = new Map()));
    let bucket = weeks.get(w);
    if (!bucket) weeks.set(w, (bucket = []));
    bucket.push(t);
  }

  const catName = new Map(ledger.categories.map((c) => [c.id, c.name]));
  const groupName = new Map(ledger.groups.map((g) => [g.id, g.name]));

  const rows = budgets.map((b) => {
    const months = byBudgetMonth.get(b.id);
    const s = standingForMonth(b, month, (mm) => months?.get(mm) ?? 0);
    const weekMap = byBudgetWeek.get(b.id);
    const sum = (ts: LedgerTxn[]) => round2(ts.reduce((acc, t) => acc + t.net, 0));
    const current = weekMap?.get(thisWeek) ?? [];
    return {
      name: b.name,
      covers: b.isRemainder
        ? "everything no other budget covers"
        : [...b.groupIds.map((g) => groupName.get(g) ?? g), ...b.categoryIds.map((c) => catName.get(c) ?? c)],
      monthly_cap: s.base,
      carryover: b.carryover,
      carried_in: round2(s.carryIn),
      available: round2(s.allowance),
      spent: round2(s.spent),
      remaining: round2(s.remaining),
      used_pct: pct(s.spent, s.allowance),
      ...(b.weeklyAmount ? { weekly_target: b.weeklyAmount } : {}),
      ...(b.weeklyCount ? { weekly_order_cap: b.weeklyCount } : {}),
      ...(isCurrent && (b.weeklyAmount || b.weeklyCount)
        ? {
            this_week: {
              start: thisWeek,
              spent: sum(current),
              orders: countOrders(current),
              ...(b.weeklyAmount ? { target_used_pct: pct(sum(current), b.weeklyAmount) } : {}),
            },
          }
        : {}),
      weeks: weekStarts.map((w) => {
        const ts = weekMap?.get(w) ?? [];
        return { start: w, spent: sum(ts), orders: countOrders(ts) };
      }),
    };
  });

  const [, , dd] = today.split("-").map(Number);
  return {
    month,
    ...(isCurrent
      ? { month_elapsed_pct: pct(dd, daysInMonth(y, m)), days_left: daysInMonth(y, m) - dd }
      : {}),
    ceiling: monthlyCeiling(budgets, month),
    spent_in_budgets: round2(rows.reduce((s, r) => s + r.spent, 0)),
    one_offs_excluded: excluded,
    ...(unbudgeted ? { not_covered_by_any_budget: unbudgeted } : {}),
    budgets: rows,
  };
}

// ── list_subscriptions ────────────────────────────────────────────────────────


export interface SubscriptionRow {
  id: string;
  label: string;
  status: string;
  cadence: Cadence | null;
  median_amount: number | null;
  amount_min: number | null;
  amount_max: number | null;
  last_amount: number | null;
  predicted_next: string | null;
}

/** Same normalisation as the app's subscriptionMonthly(). */
export function monthlyCost(median: number | null, cadence: Cadence | null): number {
  if (!median) return 0;
  const perMonth: Record<Cadence, number> = { weekly: 30 / 7, monthly: 1, quarterly: 1 / 3, annual: 1 / 12, irregular: 0 };
  return Math.round(median * perMonth[cadence ?? "irregular"]);
}

type LedgerLink = Ledger["subscriptionLinks"][number];

export function subscriptions(
  ledger: Ledger,
  subs: SubscriptionRow[],
  today: string,
  opts: { status?: string; label?: string },
) {
  const yearAgo = addDays(today, -365);
  const linksBySub = new Map<string, LedgerLink[]>();
  for (const l of ledger.subscriptionLinks) {
    let list = linksBySub.get(l.subscription_id);
    if (!list) linksBySub.set(l.subscription_id, (list = []));
    list.push(l);
  }

  let list = subs;
  if (opts.label) {
    const w = norm(opts.label);
    list = list.filter((s) => norm(s.label).includes(w));
    if (list.length === 0) {
      throw new ToolInputError(`No subscription matching "${opts.label}". Known: ${subs.map((s) => s.label).join(", ")}.`);
    }
  }
  if (opts.status) list = list.filter((s) => s.status === opts.status);

  const rows = list.map((s) => {
    // A duplicate or fully refunded charge was never really paid.
    const charges = (linksBySub.get(s.id) ?? [])
      .filter((l) => l.kind === "charge")
      .map((l) => ({ link: l, txn: ledger.byId.get(l.transaction_id) }))
      .filter((c): c is { link: LedgerLink; txn: LedgerTxn } => !!c.txn && c.txn.status === "counted")
      .sort((a, b) => (a.txn.day < b.txn.day ? 1 : -1));
    const contributions = (linksBySub.get(s.id) ?? []).filter((l) => l.kind === "contribution");
    return {
      label: s.label,
      status: s.status,
      cadence: s.cadence,
      typical_amount: s.median_amount,
      monthly_cost: monthlyCost(s.median_amount, s.cadence),
      ...(s.amount_min !== s.amount_max ? { amount_range: [s.amount_min, s.amount_max] } : {}),
      last_amount: s.last_amount,
      last_charged: charges[0]?.txn.day ?? null,
      next_expected: s.predicted_next,
      charges: charges.length,
      paid_last_12_months: round2(
        charges.filter((c) => c.txn.day >= yearAgo).reduce((acc, c) => acc + c.link.amount, 0),
      ),
      ...(contributions.length
        ? { others_paid_back: round2(contributions.reduce((acc, l) => acc + l.amount, 0)) }
        : {}),
      ...(opts.label
        ? {
            history: charges.map((c) => ({
              day: c.txn.day,
              amount: c.link.amount,
              ...(c.link.amount !== c.txn.amount ? { whole_charge: c.txn.amount } : {}),
              merchant: c.txn.merchant,
              note: c.txn.note,
            })),
          }
        : {}),
    };
  });

  return {
    all_active_monthly_total: subs
      .filter((s) => s.status === "active")
      .reduce((acc, s) => acc + monthlyCost(s.median_amount, s.cadence), 0),
    subscriptions: rows,
  };
}

// ── list_debts ────────────────────────────────────────────────────────────────

/** Mirrors DebtPage.tsx exactly, including its grouping key (lowercased,
 *  untrimmed) and not skipping duplicates, so chat and the page agree. */
export function debts(ledger: Ledger, counterparty?: string) {
  const groups = new Map<
    string,
    { name: string; lent: number; repaid: number; outstanding: number; loans: Record<string, unknown>[] }
  >();
  for (const t of ledger.txns) {
    if (t.lending?.type !== "lent") continue;
    const key = t.lending.counterparty.toLowerCase();
    if (counterparty && !key.includes(norm(counterparty))) continue;
    const repaid = round2(ledger.refundTotals.get(t.id) ?? 0);
    const outstanding = round2(Math.max(t.amount - repaid, 0));
    const g = groups.get(key) ?? { name: t.lending.counterparty, lent: 0, repaid: 0, outstanding: 0, loans: [] };
    g.lent = round2(g.lent + t.amount);
    g.repaid = round2(g.repaid + repaid);
    g.outstanding = round2(g.outstanding + outstanding);
    g.loans.push({ day: t.day, amount: t.amount, repaid, outstanding, note: t.note, merchant: t.merchant });
    groups.set(key, g);
  }
  const people = [...groups.values()].sort((a, b) => b.outstanding - a.outstanding);
  for (const p of people) p.loans.sort((a, b) => ((a.day as string) < (b.day as string) ? 1 : -1));
  return {
    total_outstanding: round2(people.reduce((s, p) => s + p.outstanding, 0)),
    total_lent: round2(people.reduce((s, p) => s + p.lent, 0)),
    people,
  };
}

// ── get_overview ──────────────────────────────────────────────────────────────

export function overview(ledger: Ledger, today: string, reviewedMonths: string[], budgetCount: number, activeSubs: number) {
  const counted = ledger.txns.filter((t) => t.status === "counted");
  const months = new Map<string, { spent: number; income: number }>();
  for (const t of counted) {
    const m = months.get(t.month) ?? { spent: 0, income: 0 };
    if (t.kind === "expense") m.spent = round2(m.spent + t.net);
    if (t.kind === "income") m.income = round2(m.income + t.net);
    months.set(t.month, m);
  }
  const reviewed = new Set(reviewedMonths);
  const usedCats = new Map<string, number>();
  for (const t of counted) if (t.kind === "expense") usedCats.set(t.category, (usedCats.get(t.category) ?? 0) + 1);
  const groupSpend = new Map<string, number>();
  for (const t of counted) if (t.group_id && t.kind === "expense") groupSpend.set(t.group_id, round2((groupSpend.get(t.group_id) ?? 0) + t.net));

  return {
    today,
    timezone: "Asia/Kolkata",
    currency: "INR",
    data_from: ledger.txns[0]?.day ?? null,
    data_to: ledger.txns[ledger.txns.length - 1]?.day ?? null,
    transactions: ledger.txns.length,
    months: [...months.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, v]) => ({ month, ...v, has_ai_review: reviewed.has(month) })),
    categories: [...new Set(ledger.categories.map((c) => c.name))]
      .sort((a, b) => (usedCats.get(b) ?? 0) - (usedCats.get(a) ?? 0))
      .map((name) => ({ name, transactions: usedCats.get(name) ?? 0 })),
    groups: ledger.groups.map((g) => ({
      name: g.name,
      spent: groupSpend.get(g.id) ?? 0,
      ...(g.archived_at ? { archived: true } : {}),
    })),
    budgets: budgetCount,
    active_subscriptions: activeSubs,
  };
}
