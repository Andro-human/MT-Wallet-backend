import { supabase } from "./supabase.js";
import { fetchAll, istDay } from "./monthlyReview.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export const UNCATEGORIZED = { slug: "uncategorized", name: "Uncategorized" } as const;

export type LedgerStatus = "counted" | "duplicate" | "refunded" | "not_counted";
/** Money out or money in, from the row's direction. Whether it counts toward
 *  spent or income is `status`. */
export type LedgerKind = "expense" | "income";

export interface Lending {
  type: "lent" | "repayment";
  counterparty: string;
}

export interface LedgerTxn {
  id: string;
  day: string;
  month: string;
  merchant: string | null;
  note: string | null;
  amount: number;
  /** amount less linked refunds (debit) or less the part allocated as a
   *  refund (credit). What every total in the app adds up. */
  net: number;
  refunded: number;
  kind: LedgerKind;
  status: LedgerStatus;
  category_id: string | null;
  category: string;
  category_slug: string;
  group_id: string | null;
  group: string | null;
  /** Shared by rows the user combined into one purchase. */
  combine: string | null;
  lending: Lending | null;
  budget_excluded: boolean;
  service: string | null;
  subscription: string | null;
  account: string | null;
}

export interface RawTxn {
  id: string;
  amount: number | string;
  merchant: string | null;
  notes: string | null;
  transacted_at: string;
  direction: string | null;
  is_expense: boolean | null;
  is_income: boolean | null;
  /** Set on a cashback credit, which is never income: it lowers a month's
   *  total spend. Wins over a stale is_income. */
  cashback_month?: string | null;
  category_id: string | null;
  group_id: string | null;
  bank_name: string | null;
  account_last4: string | null;
}

export interface SubscriptionLinkRow {
  subscription_id: string;
  transaction_id: string;
  amount: number;
  kind: string;
}

export interface LedgerInputs {
  txns: RawTxn[];
  refundLinks: {
    id: string;
    original_transaction_id: string;
    refund_transaction_id: string;
    linked_amount: number | string | null;
  }[];
  duplicateIds: string[];
  combines: { combine_id: string; transaction_id: string }[];
  categories: { id: string; name: string; slug: string }[];
  groups: { id: string; name: string; archived_at: string | null }[];
  enrichment: {
    transaction_id: string;
    lending: Lending | null;
    budget_excluded: boolean | null;
    service_identity: string | null;
  }[];
  subscriptionLinks: (SubscriptionLinkRow & { label: string })[];
}

export interface Ledger {
  txns: LedgerTxn[];
  byId: Map<string, LedgerTxn>;
  /** Linked refund money per original transaction. A loan's repayments are
   *  linked the same way, so this is also what has come back on a loan. */
  refundTotals: Map<string, number>;
  categories: LedgerInputs["categories"];
  groups: LedgerInputs["groups"];
  subscriptionLinks: SubscriptionLinkRow[];
}

/** Classification is MT-Wallet's classifyTransaction (transactionMath.ts):
 *  direction decides which flag counts. Un-marking a duplicate in the app sets
 *  both is_expense and is_income, so reading the flags alone would book a
 *  salary credit as spend. */
export function resolveLedger(input: LedgerInputs): Ledger {
  // Offset paging can return a row twice when an insert lands mid-load, and
  // every list below is summed.
  const refundLinks = new Map(input.refundLinks.map((l) => [l.id, l])).values();
  const subscriptionLinks = [
    ...new Map(input.subscriptionLinks.map((l) => [`${l.subscription_id}:${l.transaction_id}`, l])).values(),
  ];

  const refundTotals = new Map<string, number>();
  const refundAllocations = new Map<string, number>();
  for (const l of refundLinks) {
    const amt = Number(l.linked_amount ?? 0);
    if (!amt) continue;
    refundTotals.set(l.original_transaction_id, (refundTotals.get(l.original_transaction_id) ?? 0) + amt);
    refundAllocations.set(l.refund_transaction_id, (refundAllocations.get(l.refund_transaction_id) ?? 0) + amt);
  }

  const duplicates = new Set(input.duplicateIds);
  const catById = new Map(input.categories.map((c) => [c.id, c]));
  const groupById = new Map(input.groups.map((g) => [g.id, g]));
  const enrichById = new Map(input.enrichment.map((e) => [e.transaction_id, e]));
  const subByTxn = new Map<string, string>();
  for (const s of subscriptionLinks) if (s.kind === "charge") subByTxn.set(s.transaction_id, s.label);

  const combineTag = new Map<string, string>();
  const tagByCombine = new Map<string, string>();
  for (const r of input.combines) {
    let tag = tagByCombine.get(r.combine_id);
    if (!tag) {
      tag = `c${tagByCombine.size + 1}`;
      tagByCombine.set(r.combine_id, tag);
    }
    combineTag.set(r.transaction_id, tag);
  }

  const unique = new Map(input.txns.map((t) => [t.id, t]));

  const txns: LedgerTxn[] = [...unique.values()].map((t) => {
    const amount = Number(t.amount);
    const isDebit = t.direction !== "credit";
    const kind: LedgerKind = isDebit ? "expense" : "income";
    let net = 0;
    let refunded = 0;
    let status: LedgerStatus;

    if (duplicates.has(t.id)) {
      status = "duplicate";
    } else if (!(isDebit ? t.is_expense : t.is_income && !t.cashback_month)) {
      status = "not_counted";
    } else {
      refunded = round2((isDebit ? refundTotals : refundAllocations).get(t.id) ?? 0);
      net = round2(Math.max(amount - refunded, 0));
      status = net > 0 ? "counted" : "refunded";
    }

    const cat = t.category_id ? catById.get(t.category_id) : undefined;
    const enr = enrichById.get(t.id);
    const day = istDay(t.transacted_at);
    return {
      id: t.id,
      day,
      month: day.slice(0, 7),
      merchant: t.merchant,
      note: t.notes,
      amount,
      net,
      refunded,
      kind,
      status,
      category_id: t.category_id,
      category: cat?.name ?? UNCATEGORIZED.name,
      category_slug: cat?.slug ?? UNCATEGORIZED.slug,
      group_id: t.group_id,
      group: t.group_id ? (groupById.get(t.group_id)?.name ?? "Unknown Group") : null,
      combine: combineTag.get(t.id) ?? null,
      lending: enr?.lending ?? null,
      budget_excluded: enr?.budget_excluded ?? false,
      service: enr?.service_identity ?? null,
      subscription: subByTxn.get(t.id) ?? null,
      account: t.bank_name ? `${t.bank_name}${t.account_last4 ? ` ••${t.account_last4}` : ""}` : null,
    };
  });

  txns.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return {
    txns,
    byId: new Map(txns.map((t) => [t.id, t])),
    refundTotals,
    categories: input.categories,
    groups: input.groups,
    subscriptionLinks: subscriptionLinks.map(({ label: _label, ...link }) => link),
  };
}

/** The user's whole history. Budget carry walks every month since a budget
 *  began, so a date-windowed load would get carry wrong. */
export async function loadLedger(userId: string): Promise<Ledger> {
  const mine = (q: any) => q.eq("user_id", userId);
  const [txns, refundLinks, duplicates, combines, categories, groups, enrichment, subLinks, subs] =
    await Promise.all([
      fetchAll<RawTxn>(
        "transactions",
        "id, amount, merchant, notes, transacted_at, direction, is_expense, is_income, category_id, group_id, bank_name, account_last4, cashback_month",
        mine,
      ),
      fetchAll<LedgerInputs["refundLinks"][number]>(
        "refund_links",
        "id, original_transaction_id, refund_transaction_id, linked_amount",
        mine,
      ),
      fetchAll<{ duplicate_transaction_id: string }>("duplicate_links", "duplicate_transaction_id", mine),
      fetchAll<LedgerInputs["combines"][number]>("combined_transactions", "combine_id, transaction_id", mine),
      fetchAll<LedgerInputs["categories"][number]>("categories", "id, name, slug", (q) =>
        q.or(`is_system.eq.true,user_id.eq.${userId}`),
      ),
      fetchAll<LedgerInputs["groups"][number]>("transaction_groups", "id, name, archived_at", mine),
      pageBy<LedgerInputs["enrichment"][number]>(
        "txn_enrichment",
        "transaction_id, lending, budget_excluded, service_identity",
        ["transaction_id"],
        userId,
      ),
      pageBy<SubscriptionLinkRow>(
        "subscription_transactions",
        "subscription_id, transaction_id, amount, kind",
        ["transaction_id", "subscription_id"],
        userId,
      ),
      supabase.from("subscriptions").select("id, label").eq("user_id", userId),
    ]);
  if (subs.error) throw new Error(`subscriptions: ${subs.error.message}`);
  const labelBySub = new Map(((subs.data ?? []) as { id: string; label: string }[]).map((s) => [s.id, s.label]));

  return resolveLedger({
    txns,
    refundLinks,
    duplicateIds: duplicates.map((d) => d.duplicate_transaction_id),
    combines,
    categories,
    groups,
    enrichment,
    subscriptionLinks: subLinks.map((l) => ({
      ...l,
      amount: Number(l.amount),
      label: labelBySub.get(l.subscription_id) ?? "Unknown subscription",
    })),
  });
}

/** txn_enrichment and subscription_transactions have no `id` column, which
 *  fetchAll orders by. Paging needs a total order or rows repeat and vanish
 *  across page boundaries. */
async function pageBy<T>(table: string, columns: string, orderKeys: string[], userId: string): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns).eq("user_id", userId);
    for (const key of orderKeys) q = q.order(key, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

const LEDGER_TTL_MS = 30_000;
const cache = new Map<string, { at: number; ledger: Promise<Ledger> }>();

/** One chat turn is several stateless tool calls in quick succession; a short
 *  cache lets them share one full-history load. */
export function cachedLedger(userId: string, now = Date.now()): Promise<Ledger> {
  const hit = cache.get(userId);
  if (hit && now - hit.at < LEDGER_TTL_MS) return hit.ledger;
  for (const [key, entry] of cache) if (now - entry.at >= LEDGER_TTL_MS) cache.delete(key);
  const ledger = loadLedger(userId);
  cache.set(userId, { at: now, ledger });
  ledger.catch(() => {
    if (cache.get(userId)?.ledger === ledger) cache.delete(userId);
  });
  return ledger;
}
