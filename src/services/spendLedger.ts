import { supabase } from "./supabase.js";
import { fetchAll, istDay } from "./monthlyReview.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type LedgerStatus = "counted" | "duplicate" | "refunded" | "not_counted";
export type LedgerKind = "expense" | "income" | "other";

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
  /** amount less linked refunds (expense) or less the part allocated as a
   *  refund (income). What every total in the app adds up. */
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
  payment_method: string | null;
}

export interface RawTxn {
  id: string;
  amount: number | string;
  merchant: string | null;
  notes: string | null;
  transacted_at: string;
  is_expense: boolean | null;
  is_income: boolean | null;
  category_id: string | null;
  group_id: string | null;
  bank_name: string | null;
  account_last4: string | null;
  payment_method: string | null;
}

export interface LedgerInputs {
  txns: RawTxn[];
  refundLinks: { original_transaction_id: string; refund_transaction_id: string; linked_amount: number | string | null }[];
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
  subscriptionLinks: { transaction_id: string; kind: string; label: string }[];
}

export interface Ledger {
  txns: LedgerTxn[];
  byId: Map<string, LedgerTxn>;
  /** Linked refund money per original transaction. A loan's repayments are
   *  linked the same way, so this is also what has come back on a loan. */
  refundTotals: Map<string, number>;
  categories: LedgerInputs["categories"];
  groups: LedgerInputs["groups"];
}

/** Same rules as buildReviewPayloadWithIds, so a chat answer and the monthly
 *  review agree to the paisa. */
export function resolveLedger(input: LedgerInputs): Ledger {
  const refundTotals = new Map<string, number>();
  const refundAllocations = new Map<string, number>();
  for (const l of input.refundLinks) {
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
  for (const s of input.subscriptionLinks) if (s.kind === "charge") subByTxn.set(s.transaction_id, s.label);

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

  const txns: LedgerTxn[] = input.txns.map((t) => {
    const amount = Number(t.amount);
    let kind: LedgerKind = "other";
    let net = 0;
    let refunded = 0;
    let status: LedgerStatus;

    if (duplicates.has(t.id)) {
      status = "duplicate";
      kind = t.is_expense ? "expense" : t.is_income ? "income" : "other";
    } else if (t.is_expense) {
      kind = "expense";
      refunded = round2(refundTotals.get(t.id) ?? 0);
      net = round2(Math.max(amount - refunded, 0));
      status = net > 0 ? "counted" : "refunded";
    } else if (t.is_income) {
      kind = "income";
      refunded = round2(refundAllocations.get(t.id) ?? 0);
      net = round2(Math.max(amount - refunded, 0));
      status = net > 0 ? "counted" : "refunded";
    } else {
      status = "not_counted";
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
      category: cat?.name ?? "Uncategorized",
      category_slug: cat?.slug ?? "uncategorized",
      group_id: t.group_id,
      group: t.group_id ? (groupById.get(t.group_id)?.name ?? "Unknown Group") : null,
      combine: combineTag.get(t.id) ?? null,
      lending: enr?.lending ?? null,
      budget_excluded: enr?.budget_excluded ?? false,
      service: enr?.service_identity ?? null,
      subscription: subByTxn.get(t.id) ?? null,
      account: t.bank_name ? `${t.bank_name}${t.account_last4 ? ` ••${t.account_last4}` : ""}` : null,
      payment_method: t.payment_method,
    };
  });

  txns.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return {
    txns,
    byId: new Map(txns.map((t) => [t.id, t])),
    refundTotals,
    categories: input.categories,
    groups: input.groups,
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
        "id, amount, merchant, notes, transacted_at, is_expense, is_income, category_id, group_id, bank_name, account_last4, payment_method",
        mine,
      ),
      fetchAll<LedgerInputs["refundLinks"][number]>(
        "refund_links",
        "original_transaction_id, refund_transaction_id, linked_amount",
        mine,
      ),
      fetchAll<{ duplicate_transaction_id: string }>("duplicate_links", "duplicate_transaction_id", mine),
      fetchAll<LedgerInputs["combines"][number]>("combined_transactions", "combine_id, transaction_id", mine),
      fetchAll<LedgerInputs["categories"][number]>("categories", "id, name, slug", (q) =>
        q.or(`is_system.eq.true,user_id.eq.${userId}`),
      ),
      fetchAll<LedgerInputs["groups"][number]>("transaction_groups", "id, name, archived_at", mine),
      enrichmentRows(userId),
      subscriptionLinkRows(userId),
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
      transaction_id: l.transaction_id,
      kind: l.kind,
      label: labelBySub.get(l.subscription_id) ?? "Unknown subscription",
    })),
  });
}

/** txn_enrichment and subscription_transactions have no `id` column, which
 *  fetchAll orders by. Paging needs a total order or rows repeat and vanish
 *  across page boundaries. */
export async function pageBy<T>(table: string, columns: string, orderKeys: string[], userId: string): Promise<T[]> {
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

const enrichmentRows = (userId: string) =>
  pageBy<LedgerInputs["enrichment"][number]>(
    "txn_enrichment",
    "transaction_id, lending, budget_excluded, service_identity",
    ["transaction_id"],
    userId,
  );

const subscriptionLinkRows = (userId: string) =>
  pageBy<{ transaction_id: string; subscription_id: string; kind: string }>(
    "subscription_transactions",
    "transaction_id, subscription_id, kind",
    ["transaction_id", "subscription_id"],
    userId,
  );
