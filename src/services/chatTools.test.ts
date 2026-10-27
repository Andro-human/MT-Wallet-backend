import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLedger, type LedgerInputs, type RawTxn } from "./spendLedger.js";
import {
  ToolInputError,
  parsePeriod,
  parseCompare,
  weekStart,
  spendSummary,
  searchTransactions,
  budgetStatus,
  subscriptions,
  debts,
  overview,
  monthlyCost,
  monthReview,
  type SubscriptionRow,
  type StoredMonthSummary,
} from "./chatTools.js";
import { attributeTo, buildBudgetIndex, monthlyCeiling, standingForMonth, type BudgetDef } from "./budgetMath.js";

const FOOD = "cat-food";
const TRAVEL = "cat-travel";
const SALARY = "cat-salary";

function txn(id: string, day: string, amount: number, extra: Partial<RawTxn> = {}): RawTxn {
  return {
    id,
    amount,
    merchant: null,
    notes: null,
    // 12:00 IST, so the IST day is the day given.
    transacted_at: `${day}T06:30:00Z`,
    direction: "debit",
    is_expense: true,
    is_income: false,
    category_id: FOOD,
    group_id: null,
    bank_name: null,
    account_last4: null,
    ...extra,
  };
}

const credit = (id: string, day: string, amount: number, extra: Partial<RawTxn> = {}) =>
  txn(id, day, amount, { direction: "credit", is_expense: false, is_income: true, category_id: SALARY, ...extra });

function ledgerOf(txns: RawTxn[], extra: Partial<LedgerInputs> = {}) {
  return resolveLedger({
    txns,
    refundLinks: [],
    duplicateIds: [],
    combines: [],
    categories: [
      { id: FOOD, name: "Food & Dining", slug: "food" },
      { id: TRAVEL, name: "Travel", slug: "travel" },
      { id: SALARY, name: "Salary", slug: "salary" },
    ],
    groups: [{ id: "g-goa", name: "Goa trip", archived_at: null }],
    enrichment: [],
    subscriptionLinks: [],
    ...extra,
  });
}

const all = { from: "2000-01-01", to: "2099-12-31" };
const summary = (ledger: ReturnType<typeof ledgerOf>, over: Partial<Parameters<typeof spendSummary>[1]> = {}) =>
  spendSummary(ledger, { period: all, group_by: "none", kind: "expense", filter: {}, limit: 25, ...over });
const search = (ledger: ReturnType<typeof ledgerOf>, over: Partial<Parameters<typeof searchTransactions>[1]> = {}) =>
  searchTransactions(ledger, {
    period: all,
    filter: {},
    kind: "expense",
    include_uncounted: false,
    sort: "date_asc",
    limit: 50,
    ...over,
  });

// ── periods ───────────────────────────────────────────────────────────────────

test("parsePeriod: from alone runs to today, so 'since November' is one call", () => {
  assert.deepEqual(parsePeriod("2025-11", undefined, "2026-10-13"), { from: "2025-11-01", to: "2026-10-13" });
  assert.deepEqual(parsePeriod("2026", undefined, "2026-10-13"), { from: "2026-01-01", to: "2026-10-13" });
});

test("parsePeriod: to alone runs from the first transaction to the end of its span", () => {
  assert.deepEqual(parsePeriod(undefined, "2026-03", "2026-10-13", "2025-02-02"), { from: "2025-02-02", to: "2026-03-31" });
  assert.deepEqual(parsePeriod(undefined, "2024-03", "2026-10-13", "2025-02-02"), { from: "2024-03-01", to: "2024-03-31" });
  assert.deepEqual(parsePeriod(undefined, "2026-03", "2026-10-13"), { from: "2026-03-01", to: "2026-03-31" });
});

test("spend_summary: an up-to period by month starts at the data, not decades of empty rows", () => {
  const ledger = ledgerOf([txn("a", "2026-01-05", 100), txn("b", "2026-03-05", 200)]);
  const period = parsePeriod(undefined, "2026-03", "2026-10-13", ledger.txns[0].day);
  assert.deepEqual(summary(ledger, { period, group_by: "month" }).rows.map((r) => r.label), ["2026-01", "2026-02", "2026-03"]);
});

test("parsePeriod: both bounds cover their whole spans, including leap February", () => {
  assert.deepEqual(parsePeriod("2026-09", "2026-09", "2026-10-13"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(parsePeriod("2024-02", "2024-02", "2026-10-13"), { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual(parsePeriod("2026", "2026", "2026-10-13"), { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(parsePeriod("2026-01", "2026-03-15", "2026-10-13"), { from: "2026-01-01", to: "2026-03-15" });
});

test("parsePeriod: nothing given is the current month to date", () => {
  assert.deepEqual(parsePeriod(undefined, undefined, "2026-10-13"), { from: "2026-10-01", to: "2026-10-13" });
});

test("parsePeriod: rejects prose, impossible dates, far years and reversed ranges", () => {
  assert.throws(() => parsePeriod("last month", undefined, "2026-10-13"), ToolInputError);
  assert.throws(() => parsePeriod("2026-02-30", undefined, "2026-10-13"), ToolInputError);
  assert.throws(() => parsePeriod("0001", "9999", "2026-10-13"), ToolInputError);
  assert.throws(() => parsePeriod("2026-05", "2026-04", "2026-10-13"), /after/);
});

test("parseCompare: needs both ends or neither", () => {
  assert.equal(parseCompare(undefined, undefined, "2026-10-13"), undefined);
  assert.deepEqual(parseCompare("2026-08", "2026-08", "2026-10-13"), { from: "2026-08-01", to: "2026-08-31" });
  assert.throws(() => parseCompare("2026-08", undefined, "2026-10-13"), /both compare_from and compare_to/);
});

test("weekStart is the Monday", () => {
  assert.equal(weekStart("2026-10-13"), "2026-10-12");
  assert.equal(weekStart("2026-10-12"), "2026-10-12");
  assert.equal(weekStart("2026-10-18"), "2026-10-12");
});

// ── ledger ────────────────────────────────────────────────────────────────────

test("ledger: refunds net, duplicates and transfers drop out, income allocations reduce income", () => {
  const ledger = ledgerOf(
    [
      txn("a", "2026-09-01", 1000),
      credit("refund", "2026-09-03", 300),
      txn("dup", "2026-09-01", 1000, { is_expense: false }),
      txn("full", "2026-09-02", 500),
      credit("refund2", "2026-09-04", 500, { is_income: false }),
      credit("salary", "2026-09-05", 50000),
      txn("transfer", "2026-09-06", 2000, { is_expense: false }),
    ],
    {
      refundLinks: [
        { id: "rl1", original_transaction_id: "a", refund_transaction_id: "refund", linked_amount: 300 },
        { id: "rl2", original_transaction_id: "full", refund_transaction_id: "refund2", linked_amount: 500 },
      ],
      duplicateIds: ["dup"],
    },
  );
  const byId = (id: string) => ledger.byId.get(id)!;
  assert.equal(byId("a").net, 700);
  assert.equal(byId("a").status, "counted");
  assert.equal(byId("refund").status, "refunded");
  assert.equal(byId("dup").status, "duplicate");
  assert.equal(byId("full").status, "refunded");
  assert.equal(byId("transfer").status, "not_counted");

  const s = summary(ledger);
  assert.equal(s.total, 700);
  assert.deepEqual(s.not_included, { duplicates: 1, fully_refunded: 2, transfers_and_uncounted: 2 });
  assert.equal(summary(ledger, { kind: "income" }).total, 50000);
});

test("ledger: direction decides which flag counts, so a credit carrying both flags is income only", () => {
  // Un-marking a duplicate in the app sets is_expense and is_income together.
  const ledger = ledgerOf([credit("salary", "2026-09-01", 50000, { is_expense: true })]);
  assert.equal(ledger.byId.get("salary")!.kind, "income");
  assert.equal(summary(ledger).total, 0);
  assert.equal(summary(ledger, { kind: "income" }).total, 50000);
});

test("ledger: rows returned twice by paging count once, links included", () => {
  const link = { id: "rl-dup", original_transaction_id: "a", refund_transaction_id: "r", linked_amount: 30 };
  const charge = { subscription_id: "s", transaction_id: "a", amount: 100, kind: "charge", label: "S" };
  const ledger = ledgerOf([txn("a", "2026-09-01", 100), txn("a", "2026-09-01", 100)], {
    refundLinks: [link, link],
    subscriptionLinks: [charge, charge],
  });
  assert.equal(ledger.txns.length, 1);
  assert.equal(summary(ledger).total, 70);
  assert.equal(ledger.subscriptionLinks.length, 1);
});

test("ledger: the day is the IST day, not the UTC one", () => {
  const ledger = ledgerOf([txn("late", "2026-09-30", 100, { transacted_at: "2026-09-30T19:00:00Z" })]);
  assert.equal(ledger.byId.get("late")!.day, "2026-10-01");
  assert.equal(ledger.byId.get("late")!.month, "2026-10");
});

test("ledger: partial income allocation, ignored zero links and summed refunds", () => {
  const ledger = ledgerOf([txn("order", "2026-09-01", 1000), credit("back", "2026-09-02", 1000)], {
    refundLinks: [
      { id: "rl3", original_transaction_id: "order", refund_transaction_id: "back", linked_amount: 200 },
      { id: "rl4", original_transaction_id: "order", refund_transaction_id: "back", linked_amount: "100" },
      { id: "rl5", original_transaction_id: "order", refund_transaction_id: "back", linked_amount: null },
      { id: "rl6", original_transaction_id: "order", refund_transaction_id: "back", linked_amount: 0 },
    ],
  });
  assert.equal(ledger.byId.get("order")!.net, 700);
  assert.equal(ledger.byId.get("back")!.net, 700);
  assert.equal(ledger.byId.get("back")!.status, "counted");
});

test("ledger: fallback labels for missing category and group, and the account label", () => {
  const ledger = ledgerOf([
    txn("x", "2026-09-01", 100, { category_id: "deleted", group_id: "gone", bank_name: "HDFC", account_last4: "1234" }),
    txn("y", "2026-09-01", 100, { category_id: null, bank_name: "Kotak" }),
  ]);
  const x = ledger.byId.get("x")!;
  assert.equal(x.category, "Uncategorized");
  assert.equal(x.group, "Unknown Group");
  assert.equal(x.account, "HDFC ••1234");
  assert.equal(ledger.byId.get("y")!.account, "Kotak");
});

test("ledger: only a subscription charge labels a transaction, not a contribution", () => {
  const ledger = ledgerOf([txn("c", "2026-09-01", 299), credit("back", "2026-09-02", 150)], {
    subscriptionLinks: [
      { subscription_id: "s", transaction_id: "c", amount: 299, kind: "charge", label: "YouTube" },
      { subscription_id: "s", transaction_id: "back", amount: 150, kind: "contribution", label: "YouTube" },
    ],
  });
  assert.equal(ledger.byId.get("c")!.subscription, "YouTube");
  assert.equal(ledger.byId.get("back")!.subscription, null);
});

// ── spend_summary ─────────────────────────────────────────────────────────────

test("spend_summary: combined rows count as one order", () => {
  const ledger = ledgerOf([txn("x", "2026-09-01", 100), txn("y", "2026-09-01", 50), txn("z", "2026-09-02", 70)], {
    combines: [
      { combine_id: "k1", transaction_id: "x" },
      { combine_id: "k1", transaction_id: "y" },
    ],
  });
  const s = summary(ledger);
  assert.equal(s.count, 3);
  assert.equal(s.orders, 2);
});

test("spend_summary: compare keeps rows that only existed in either period", () => {
  const ledger = ledgerOf([
    txn("aug-food", "2026-08-10", 400),
    txn("aug-travel", "2026-08-11", 5000, { category_id: TRAVEL }),
    txn("sep-food", "2026-09-10", 600),
    txn("sep-new", "2026-09-11", 300, { category_id: null }),
  ]);
  const s = summary(ledger, {
    period: { from: "2026-09-01", to: "2026-09-30" },
    compare: { from: "2026-08-01", to: "2026-08-31" },
    group_by: "category",
  });
  assert.equal(s.total, 900);
  assert.equal(s.compare_total, 5400);
  assert.equal(s.change, -4500);
  const row = (label: string) => s.rows.find((r) => r.label === label)!;
  assert.equal(row("Travel").total, 0);
  assert.equal(row("Travel").change, -5000);
  assert.equal(row("Food & Dining").change_pct, 50);
  assert.equal(row("Uncategorized").previous_total, 0);
  assert.equal(row("Uncategorized").change_pct, null);
});

test("spend_summary: month grouping fills empty months in order and ignores limit", () => {
  const ledger = ledgerOf([txn("a", "2025-12-05", 100), txn("b", "2026-02-05", 200)]);
  const s = summary(ledger, { period: { from: "2025-12-01", to: "2026-02-28" }, group_by: "month", limit: 1 });
  assert.deepEqual(
    s.rows.map((r) => [r.label, r.total]),
    [
      ["2025-12", 100],
      ["2026-01", 0],
      ["2026-02", 200],
    ],
  );
});

test("spend_summary: week grouping fills empty weeks from the Monday on or before from", () => {
  const ledger = ledgerOf([txn("a", "2026-09-02", 100), txn("b", "2026-09-16", 200)]);
  const s = summary(ledger, { period: { from: "2026-09-02", to: "2026-09-16" }, group_by: "week" });
  assert.deepEqual(
    s.rows.map((r) => [r.label, r.total]),
    [
      ["week of 2026-08-31", 100],
      ["week of 2026-09-07", 0],
      ["week of 2026-09-14", 200],
    ],
  );
});

test("spend_summary: day and week groupings refuse spans too long to list", () => {
  const ledger = ledgerOf([]);
  assert.throws(() => summary(ledger, { period: { from: "2026-01-01", to: "2026-12-31" }, group_by: "day" }), /120 days/);
  assert.throws(() => summary(ledger, { period: { from: "2000-01-01", to: "2026-12-31" }, group_by: "week" }), /ten years/);
});

test("spend_summary: rows past the limit fold into one total", () => {
  const ledger = ledgerOf(["a", "b", "c", "d"].map((m, i) => txn(m, "2026-09-01", 100 * (i + 1), { merchant: m })));
  const s = summary(ledger, { group_by: "merchant", limit: 2 });
  assert.equal(s.rows.length, 2);
  assert.deepEqual(s.more_rows_folded, { rows: 2, total: 300 });
});

test("spend_summary: merchants group case-insensitively under the commonest spelling", () => {
  const ledger = ledgerOf([
    txn("a", "2026-09-01", 100, { merchant: "Swiggy" }),
    txn("b", "2026-09-02", 100, { merchant: "swiggy " }),
    txn("c", "2026-09-03", 100, { merchant: "Swiggy" }),
  ]);
  assert.deepEqual(summary(ledger, { group_by: "merchant" }).rows.map((r) => [r.label, r.total]), [["Swiggy", 300]]);
});

test("spend_summary: rows without a group or account get a readable label", () => {
  const ledger = ledgerOf([txn("a", "2026-09-01", 100)]);
  assert.equal(summary(ledger, { group_by: "group" }).rows[0].label, "(not in a group)");
  assert.equal(summary(ledger, { group_by: "account" }).rows[0].label, "(unknown account)");
});

test("spend_summary: compare with a time grouping is refused", () => {
  assert.throws(() => summary(ledgerOf([]), { compare: all, group_by: "month" }), ToolInputError);
});

// ── filters ───────────────────────────────────────────────────────────────────

test("filters: category by name or slug, group, account, and every text word", () => {
  const ledger = ledgerOf([
    txn("a", "2026-09-01", 100, { merchant: "Country Delight", notes: "milk", bank_name: "HDFC", account_last4: "1234" }),
    txn("b", "2026-09-02", 200, { merchant: "Country Delight", notes: "paneer" }),
    txn("c", "2026-09-03", 900, { category_id: TRAVEL, group_id: "g-goa" }),
  ]);
  const total = (filter: object) => summary(ledger, { filter }).total;
  assert.equal(total({ category: "food" }), 300);
  assert.equal(total({ category: "FOOD & dining" }), 300);
  assert.equal(total({ group: "goa trip" }), 900);
  assert.equal(total({ text: "country milk" }), 100);
  assert.equal(total({ account: "1234" }), 100);
  assert.equal(total({ min_amount: 150, max_amount: 500 }), 200);
  assert.throws(() => total({ category: "nope" }), /Known categories: Food & Dining, Salary, Travel/);
  assert.throws(() => total({ group: "nope" }), /Known groups: Goa trip/);
});

test("filters: 'uncategorized' matches null and deleted categories alike", () => {
  const ledger = ledgerOf([
    txn("a", "2026-09-01", 100, { category_id: null }),
    txn("b", "2026-09-01", 200, { category_id: "deleted" }),
    txn("c", "2026-09-01", 400),
  ]);
  assert.equal(summary(ledger, { filter: { category: "Uncategorized" } }).total, 300);
});

test("filters: text also matches subscription, service and lending counterparty", () => {
  const ledger = ledgerOf([txn("s", "2026-09-01", 299), txn("l", "2026-09-02", 800)], {
    subscriptionLinks: [{ subscription_id: "x", transaction_id: "s", amount: 299, kind: "charge", label: "YouTube Premium" }],
    enrichment: [
      { transaction_id: "l", lending: { type: "lent", counterparty: "Muskan" }, budget_excluded: false, service_identity: null },
    ],
  });
  assert.equal(summary(ledger, { filter: { text: "youtube" } }).total, 299);
  assert.equal(summary(ledger, { filter: { text: "muskan" } }).total, 800);
});

// ── search_transactions ───────────────────────────────────────────────────────

test("search_transactions: totals cover every match even when rows are truncated", () => {
  const ledger = ledgerOf([txn("a", "2026-09-01", 100), txn("b", "2026-09-02", 300), txn("c", "2026-09-03", 200)]);
  const r = search(ledger, { sort: "amount_desc", limit: 2 });
  assert.equal(r.matched, 3);
  assert.equal(r.spent_total, 600);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.transactions.map((t) => t.amount), [300, 200]);
  assert.deepEqual(search(ledger, { sort: "amount_asc" }).transactions.map((t) => t.amount), [100, 200, 300]);
  assert.deepEqual(search(ledger, { sort: "date_desc" }).transactions.map((t) => t.day), ["2026-09-03", "2026-09-02", "2026-09-01"]);
});

test("search_transactions: duplicates and transfers show when asked, even under the default kind", () => {
  const ledger = ledgerOf(
    [txn("a", "2026-09-01", 100), txn("d", "2026-09-01", 100, { is_expense: false }), txn("t", "2026-09-02", 5000, { is_expense: false })],
    { duplicateIds: ["d"] },
  );
  assert.equal(search(ledger).matched, 1);
  assert.deepEqual(search(ledger).not_included, { duplicates: 1, fully_refunded: 0, transfers_and_uncounted: 1 });
  const withAll = search(ledger, { include_uncounted: true });
  assert.equal(withAll.matched, 3);
  assert.deepEqual(withAll.transactions.map((t) => t.status ?? "counted"), ["counted", "duplicate", "not_counted"]);
  assert.equal(withAll.spent_total, 100);
  assert.equal("not_included" in withAll, false);
});

test("search_transactions: amount filters use the face amount for rows that don't count", () => {
  const ledger = ledgerOf([txn("t", "2026-09-02", 5000, { is_expense: false })]);
  assert.equal(search(ledger, { include_uncounted: true, filter: { min_amount: 4000 } }).matched, 1);
});

test("search_transactions: income kind and a partly refunded row's gross", () => {
  const ledger = ledgerOf([txn("o", "2026-09-01", 1000), credit("r", "2026-09-02", 400, { is_income: false }), credit("s", "2026-09-03", 9000)], {
    refundLinks: [{ id: "rl7", original_transaction_id: "o", refund_transaction_id: "r", linked_amount: 400 }],
  });
  const income = search(ledger, { kind: "income" });
  assert.equal(income.income_total, 9000);
  assert.equal(income.matched, 1);
  const o = search(ledger).transactions[0];
  assert.deepEqual([o.amount, o.refunded, o.gross], [600, 400, 1000]);
});

// ── get_month_review ──────────────────────────────────────────────────────────

const storedReview = (over: Partial<StoredMonthSummary> = {}): StoredMonthSummary => ({
  month: "2026-09",
  highlights: ["Trip"],
  spend_slices: [{ label: "Patna trip", amount: 15318, count: 1, txn_ids: ["f1"] }],
  category_breakdowns: [
    {
      name: "Travel",
      total: 15318,
      one_liner: null,
      groups: [
        { label: "Flights", amount: 15318, count: 1, txn_ids: ["f1"] },
        { label: "Old label", amount: 1, count: 1 },
      ],
    },
  ],
  generated_at: null,
  ...over,
});

test("get_month_review: expand resolves a slice or a category group to its transactions", () => {
  const ledger = ledgerOf([txn("f1", "2026-09-11", 15318, { category_id: TRAVEL, notes: "flight" })]);
  const expanded = (label: string) =>
    (monthReview(ledger, "2026-09", storedReview(), [], label) as unknown as { expanded: { transactions: { note: string }[] } })
      .expanded;
  assert.equal(expanded("patna TRIP").transactions[0].note, "flight");
  assert.equal(expanded("flights").transactions[0].note, "flight");
});

test("get_month_review: an unknown label lists only labels that can be expanded", () => {
  const ledger = ledgerOf([]);
  assert.throws(() => monthReview(ledger, "2026-09", storedReview(), [], "nope"), /Labels: Flights, Patna trip\./);
  assert.throws(() => monthReview(ledger, "2026-09", storedReview(), [], "old label"), /without its transactions/);
});

test("get_month_review: a month with no review still returns live totals and day summaries", () => {
  const ledger = ledgerOf([txn("a", "2026-09-01", 100), credit("s", "2026-09-01", 5000)]);
  const r = monthReview(ledger, "2026-09", null, [{ day: "2026-09-01", summary: "Milk." }]) as {
    review: null;
    live_totals: { spent: number; income: number };
    day_summaries: unknown[];
  };
  assert.equal(r.review, null);
  assert.deepEqual(r.live_totals, { spent: 100, income: 5000 });
  assert.equal(r.day_summaries.length, 1);
});

// ── budgets ───────────────────────────────────────────────────────────────────

const budget = (over: Partial<BudgetDef>): BudgetDef => ({
  id: "b",
  name: "Food",
  amount: 1000,
  weeklyAmount: null,
  weeklyCount: null,
  carryover: false,
  isRemainder: false,
  activeFrom: "2026-08-01",
  categoryIds: [FOOD],
  groupIds: [],
  ...over,
});

function standings(r: ReturnType<typeof budgetStatus>) {
  assert.ok("ceiling" in r);
  return r;
}

test("budget_status: carry walks from active_from and a deficit floors at one month", () => {
  const ledger = ledgerOf([txn("aug", "2026-08-10", 3000), txn("sep", "2026-09-10", 200)]);
  const r = standings(budgetStatus(ledger, [budget({ carryover: true })], "2026-09", "2026-09-15"));
  const food = r.budgets[0];
  assert.equal(food.carried_in, -1000);
  assert.equal(food.available, 0);
  assert.equal(food.spent, 200);
  assert.equal(food.remaining, -200);
  assert.equal(r.month_elapsed_pct, 50);
  assert.equal(r.days_left, 15);
});

test("budget_status: a surplus carries forward, across a year boundary", () => {
  const ledger = ledgerOf([txn("dec", "2025-12-10", 400)]);
  const r = standings(budgetStatus(ledger, [budget({ carryover: true, activeFrom: "2025-12-01" })], "2026-01", "2026-03-01"));
  assert.equal(r.budgets[0].carried_in, 600);
  assert.equal(r.budgets[0].available, 1600);
});

test("budget_status: one-offs are reported, not charged; groups beat categories; remainder catches the rest", () => {
  const ledger = ledgerOf(
    [
      txn("meal", "2026-09-01", 300),
      txn("laptop", "2026-09-02", 50000, { category_id: TRAVEL }),
      txn("goa-dinner", "2026-09-03", 800, { group_id: "g-goa" }),
      txn("taxi", "2026-09-04", 400, { category_id: TRAVEL }),
    ],
    { enrichment: [{ transaction_id: "laptop", lending: null, budget_excluded: true, service_identity: null }] },
  );
  const r = standings(
    budgetStatus(
      ledger,
      [
        budget({}),
        budget({ id: "trip", name: "Trips", amount: 5000, categoryIds: [], groupIds: ["g-goa"] }),
        budget({ id: "misc", name: "Misc", amount: 2000, categoryIds: [], isRemainder: true }),
      ],
      "2026-09",
      "2026-10-13",
    ),
  );
  assert.deepEqual(Object.fromEntries(r.budgets.map((b) => [b.name, b.spent])), { Food: 300, Trips: 800, Misc: 400 });
  assert.equal(r.one_offs_excluded, 50000);
  assert.equal(r.ceiling, 8000);
  assert.equal("month_elapsed_pct" in r, false);
  assert.equal(r.budgets[2].covers, "everything no other budget covers");
  assert.deepEqual(r.budgets[1].covers, ["Goa trip"]);
});

test("budget_status: spend no budget claims is reported when there is no remainder", () => {
  const ledger = ledgerOf([txn("taxi", "2026-09-04", 400, { category_id: TRAVEL })]);
  const r = standings(budgetStatus(ledger, [budget({})], "2026-09", "2026-10-13"));
  assert.equal(r.not_covered_by_any_budget, 400);
});

test("budget_status: weekly rows span the month's edge weeks, and this week appears for weekly targets", () => {
  const ledger = ledgerOf([txn("edge", "2026-09-29", 100), txn("now", "2026-10-13", 250), txn("old", "2026-06-01", 999)]);
  const r = standings(
    budgetStatus(ledger, [budget({ weeklyAmount: 500, weeklyCount: 3 }), budget({ id: "plain", name: "Plain", categoryIds: [] })], "2026-10", "2026-10-13"),
  );
  const food = r.budgets[0];
  assert.equal(food.weeks[0].start, "2026-09-28");
  assert.equal(food.weeks[0].spent, 100);
  assert.equal(food.spent, 250);
  assert.deepEqual(food.this_week, { start: "2026-10-12", spent: 250, orders: 1, target_used_pct: 50 });
  assert.equal("this_week" in r.budgets[1], false);
});

test("budget_status: no budgets says so", () => {
  const r = budgetStatus(ledgerOf([]), [], "2026-09", "2026-10-13");
  assert.equal("message" in r && r.message, "No budgets are set up.");
});

test("budgetMath: attribution falls through an unbudgeted group, and nothing claims without a remainder", () => {
  const index = buildBudgetIndex([budget({}), budget({ id: "late", categoryIds: [FOOD] })]);
  assert.equal(attributeTo({ category_id: FOOD, group_id: "g-goa" }, index), "b");
  assert.equal(attributeTo({ category_id: TRAVEL }, index), null);
});

test("budgetMath: a budget is zero before active_from and not in that month's ceiling", () => {
  const b = budget({ activeFrom: "2026-10-01" });
  assert.deepEqual(standingForMonth(b, "2026-09", () => 500), { base: 0, carryIn: 0, allowance: 0, spent: 0, remaining: 0 });
  assert.equal(monthlyCeiling([b, budget({ id: "x", amount: 300 })], "2026-09"), 300);
});

// ── subscriptions ─────────────────────────────────────────────────────────────

const sub = (over: Partial<SubscriptionRow>): SubscriptionRow => ({
  id: "yt",
  label: "YouTube Premium",
  status: "active",
  cadence: "monthly",
  median_amount: 299,
  amount_min: 299,
  amount_max: 299,
  last_amount: 299,
  predicted_next: "2026-11-11",
  ...over,
});

test("list_subscriptions: attributed amounts, 12-month window, skipped duplicates, contributions", () => {
  const ledger = ledgerOf(
    [txn("c1", "2026-10-11", 649), txn("c2", "2026-09-08", 299), txn("old", "2025-09-01", 299), txn("dup", "2026-10-11", 299), credit("back", "2026-10-12", 150)],
    {
      duplicateIds: ["dup"],
      subscriptionLinks: [
        { subscription_id: "yt", transaction_id: "c1", amount: 299, kind: "charge", label: "YouTube Premium" },
        { subscription_id: "yt", transaction_id: "c2", amount: 299, kind: "charge", label: "YouTube Premium" },
        { subscription_id: "yt", transaction_id: "old", amount: 299, kind: "charge", label: "YouTube Premium" },
        { subscription_id: "yt", transaction_id: "dup", amount: 299, kind: "charge", label: "YouTube Premium" },
        { subscription_id: "yt", transaction_id: "back", amount: 150, kind: "contribution", label: "YouTube Premium" },
      ],
    },
  );
  const r = subscriptions(ledger, [sub({})], "2026-10-13", { label: "youtube" });
  const yt = r.subscriptions[0] as ReturnType<typeof subscriptions>["subscriptions"][number] & {
    history: { day: string; whole_charge?: number }[];
  };
  assert.equal(yt.charges, 3);
  assert.equal(yt.last_charged, "2026-10-11");
  assert.equal(yt.paid_last_12_months, 598);
  assert.equal(yt.others_paid_back, 150);
  assert.equal(yt.history[0].whole_charge, 649);
  assert.equal(yt.history[1].whole_charge, undefined);
});

test("list_subscriptions: the all-active total ignores filters; an unknown label lists what exists", () => {
  const subs = [sub({}), sub({ id: "ins", label: "Life Insurance", median_amount: 1200, cadence: "annual" }), sub({ id: "x", label: "Old", status: "cancelled" })];
  const ledger = ledgerOf([]);
  assert.equal(subscriptions(ledger, subs, "2026-10-13", { label: "youtube" }).all_active_monthly_total, 399);
  assert.equal(subscriptions(ledger, subs, "2026-10-13", { status: "cancelled" }).subscriptions.length, 1);
  assert.equal(subscriptions(ledger, subs, "2026-10-13", { label: "youtube", status: "cancelled" }).subscriptions.length, 0);
  assert.throws(() => subscriptions(ledger, subs, "2026-10-13", { label: "netflix" }), /Known: YouTube Premium, Life Insurance, Old/);
});

test("monthlyCost normalises cadence like the app", () => {
  assert.equal(monthlyCost(1200, "annual"), 100);
  assert.equal(monthlyCost(299, "monthly"), 299);
  assert.equal(monthlyCost(100, "weekly"), 429);
  assert.equal(monthlyCost(500, "irregular"), 0);
  assert.equal(monthlyCost(null, "monthly"), 0);
});

// ── debts ─────────────────────────────────────────────────────────────────────

test("list_debts: repaid is what was linked back; over-repayment clamps; largest outstanding first", () => {
  const lent = (counterparty: string) => ({ type: "lent" as const, counterparty });
  const ledger = ledgerOf(
    [
      txn("l1", "2026-09-28", 800, { is_expense: false }),
      txn("l2", "2026-10-06", 3000, { is_expense: false }),
      txn("l3", "2026-10-01", 500, { is_expense: false }),
      credit("back", "2026-10-01", 400, { is_income: false }),
      credit("over", "2026-10-02", 900, { is_income: false }),
    ],
    {
      enrichment: [
        { transaction_id: "l1", lending: lent("Muskan"), budget_excluded: false, service_identity: null },
        { transaction_id: "l2", lending: lent("muskan"), budget_excluded: false, service_identity: null },
        { transaction_id: "l3", lending: lent("Raghav"), budget_excluded: false, service_identity: null },
        { transaction_id: "back", lending: { type: "repayment", counterparty: "Muskan" }, budget_excluded: false, service_identity: null },
      ],
      refundLinks: [
        { id: "rl8", original_transaction_id: "l1", refund_transaction_id: "back", linked_amount: 400 },
        { id: "rl9", original_transaction_id: "l3", refund_transaction_id: "over", linked_amount: 900 },
      ],
    },
  );
  const r = debts(ledger);
  assert.deepEqual(r.people.map((p) => [p.name, p.outstanding]), [["Muskan", 3400], ["Raghav", 0]]);
  assert.equal(r.total_lent, 4300);
  assert.equal(r.total_outstanding, 3400);
  assert.equal(debts(ledger, "musk").people.length, 1);
  assert.equal(debts(ledger, "nobody").people.length, 0);
});

// ── overview ──────────────────────────────────────────────────────────────────

test("get_overview: month totals from counted rows, review flags, usage-ordered categories, group spend", () => {
  const ledger = ledgerOf(
    [
      txn("b", "2026-09-05", 300, { category_id: TRAVEL, group_id: "g-goa" }),
      txn("a", "2026-08-05", 100),
      txn("c", "2026-09-06", 50, { category_id: TRAVEL }),
      credit("s", "2026-09-01", 5000, { group_id: "g-goa" }),
      txn("d", "2026-09-07", 999, { is_expense: false }),
    ],
  );
  const r = overview(ledger, "2026-10-13", ["2026-08"], 2, 1);
  assert.equal(r.data_from, "2026-08-05");
  assert.equal(r.data_to, "2026-09-07");
  assert.deepEqual(r.months, [
    { month: "2026-08", spent: 100, income: 0, has_ai_review: true },
    { month: "2026-09", spent: 350, income: 5000, has_ai_review: false },
  ]);
  assert.deepEqual(r.categories[0], { name: "Travel", transactions: 2 });
  assert.deepEqual(r.groups, [{ name: "Goa trip", spent: 300 }]);
  assert.equal(overview(ledgerOf([]), "2026-10-13", [], 0, 0).data_from, null);
});

test("a cashback credit is never income, even with a stale is_income", () => {
  const ledger = ledgerOf([
    credit("pay", "2026-10-01", 50_000),
    credit("cb", "2026-10-03", 1246, { cashback_month: "2026-09-01" }),
  ]);
  assert.equal(ledger.byId.get("cb")!.status, "not_counted");
  assert.equal(summary(ledger, { kind: "income" }).total, 50_000);
});
