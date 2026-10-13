import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLedger, type LedgerInputs, type RawTxn } from "./spendLedger.js";
import {
  ToolInputError,
  parsePeriod,
  weekStart,
  spendSummary,
  searchTransactions,
  budgetStatus,
  debts,
  monthlyCost,
  monthReview,
} from "./chatTools.js";
import type { BudgetDef } from "./budgetMath.js";

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
    is_expense: true,
    is_income: false,
    category_id: FOOD,
    group_id: null,
    bank_name: null,
    account_last4: null,
    payment_method: null,
    ...extra,
  };
}

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

const all = { from: "2000-01-01", to: "2100-12-31" };

test("parsePeriod: a lone bound covers its whole span", () => {
  assert.deepEqual(parsePeriod("2026-09", undefined, "2026-10-13"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(parsePeriod("2024-02", undefined, "2026-10-13"), { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual(parsePeriod("2026", undefined, "2026-10-13"), { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(parsePeriod(undefined, "2026-03", "2026-10-13"), { from: "2026-03-01", to: "2026-03-31" });
  assert.deepEqual(parsePeriod("2026-01", "2026-03-15", "2026-10-13"), { from: "2026-01-01", to: "2026-03-15" });
});

test("parsePeriod: nothing given is the current month to date", () => {
  assert.deepEqual(parsePeriod(undefined, undefined, "2026-10-13"), { from: "2026-10-01", to: "2026-10-13" });
});

test("parsePeriod: rejects prose and reversed ranges with a message the model can act on", () => {
  assert.throws(() => parsePeriod("last month", undefined, "2026-10-13"), ToolInputError);
  assert.throws(() => parsePeriod("2026-05", "2026-04", "2026-10-13"), /after/);
});

test("weekStart is the Monday", () => {
  assert.equal(weekStart("2026-10-13"), "2026-10-12");
  assert.equal(weekStart("2026-10-12"), "2026-10-12");
  assert.equal(weekStart("2026-10-18"), "2026-10-12");
});

test("ledger: refunds net, duplicates and transfers drop out, income allocations reduce income", () => {
  const ledger = ledgerOf(
    [
      txn("a", "2026-09-01", 1000),
      txn("refund", "2026-09-03", 300, { is_expense: false, is_income: true, category_id: SALARY }),
      txn("dup", "2026-09-01", 1000, { is_expense: false }),
      txn("full", "2026-09-02", 500),
      txn("refund2", "2026-09-04", 500, { is_expense: false, is_income: false }),
      txn("salary", "2026-09-05", 50000, { is_expense: false, is_income: true, category_id: SALARY }),
      txn("transfer", "2026-09-06", 2000, { is_expense: false, is_income: false }),
    ],
    {
      refundLinks: [
        { original_transaction_id: "a", refund_transaction_id: "refund", linked_amount: 300 },
        { original_transaction_id: "full", refund_transaction_id: "refund2", linked_amount: 500 },
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

  const s = spendSummary(ledger, { period: all, group_by: "none", kind: "expense", filter: {}, limit: 10 });
  assert.equal(s.total, 700);
  assert.deepEqual(s.not_included, { duplicates: 1, fully_refunded: 2, transfers_and_uncounted: 2 });
  const inc = spendSummary(ledger, { period: all, group_by: "none", kind: "income", filter: {}, limit: 10 });
  assert.equal(inc.total, 50000);
});

test("ledger: only a subscription charge labels a transaction, not a contribution", () => {
  const ledger = ledgerOf([txn("c", "2026-09-01", 299), txn("back", "2026-09-02", 150)], {
    subscriptionLinks: [
      { transaction_id: "c", kind: "charge", label: "YouTube" },
      { transaction_id: "back", kind: "contribution", label: "YouTube" },
    ],
  });
  assert.equal(ledger.byId.get("c")!.subscription, "YouTube");
  assert.equal(ledger.byId.get("back")!.subscription, null);
});

test("spend_summary: combined rows count as one order", () => {
  const ledger = ledgerOf([txn("x", "2026-09-01", 100), txn("y", "2026-09-01", 50), txn("z", "2026-09-02", 70)], {
    combines: [
      { combine_id: "k1", transaction_id: "x" },
      { combine_id: "k1", transaction_id: "y" },
    ],
  });
  const s = spendSummary(ledger, { period: all, group_by: "none", kind: "expense", filter: {}, limit: 10 });
  assert.equal(s.count, 3);
  assert.equal(s.orders, 2);
});

test("spend_summary: compare keeps rows that only existed in the earlier period", () => {
  const ledger = ledgerOf([
    txn("aug-food", "2026-08-10", 400),
    txn("aug-travel", "2026-08-11", 5000, { category_id: TRAVEL }),
    txn("sep-food", "2026-09-10", 600),
  ]);
  const s = spendSummary(ledger, {
    period: { from: "2026-09-01", to: "2026-09-30" },
    compare: { from: "2026-08-01", to: "2026-08-31" },
    group_by: "category",
    kind: "expense",
    filter: {},
    limit: 10,
  });
  assert.equal(s.total, 600);
  assert.equal(s.compare_total, 5400);
  assert.equal(s.change, -4800);
  const travel = s.rows.find((r) => r.label === "Travel")!;
  assert.equal(travel.total, 0);
  assert.equal(travel.change, -5000);
  const food = s.rows.find((r) => r.label === "Food & Dining")!;
  assert.equal(food.change_pct, 50);
});

test("spend_summary: month grouping fills empty months in order", () => {
  const ledger = ledgerOf([txn("a", "2026-01-05", 100), txn("b", "2026-03-05", 200)]);
  const s = spendSummary(ledger, {
    period: { from: "2026-01-01", to: "2026-03-31" },
    group_by: "month",
    kind: "expense",
    filter: {},
    limit: 10,
  });
  assert.deepEqual(
    s.rows.map((r) => [r.label, r.total]),
    [
      ["2026-01", 100],
      ["2026-02", 0],
      ["2026-03", 200],
    ],
  );
});

test("spend_summary: rows past the limit fold into one total", () => {
  const ledger = ledgerOf(
    ["a", "b", "c", "d"].map((m, i) => txn(m, "2026-09-01", 100 * (i + 1), { merchant: m })),
  );
  const s = spendSummary(ledger, { period: all, group_by: "merchant", kind: "expense", filter: {}, limit: 2 });
  assert.equal(s.rows.length, 2);
  assert.deepEqual(s.more_rows_folded, { rows: 2, total: 300 });
});

test("spend_summary: merchants group case-insensitively under the commonest spelling", () => {
  const ledger = ledgerOf([
    txn("a", "2026-09-01", 100, { merchant: "Swiggy" }),
    txn("b", "2026-09-02", 100, { merchant: "swiggy " }),
    txn("c", "2026-09-03", 100, { merchant: "Swiggy" }),
  ]);
  const s = spendSummary(ledger, { period: all, group_by: "merchant", kind: "expense", filter: {}, limit: 10 });
  assert.deepEqual(s.rows.map((r) => [r.label, r.total]), [["Swiggy", 300]]);
});

test("spend_summary: compare with a time grouping is refused", () => {
  const ledger = ledgerOf([]);
  assert.throws(
    () =>
      spendSummary(ledger, {
        period: all,
        compare: all,
        group_by: "month",
        kind: "expense",
        filter: {},
        limit: 10,
      }),
    ToolInputError,
  );
});

test("filters: category by name or slug, group, and every text word", () => {
  const ledger = ledgerOf([
    txn("a", "2026-09-01", 100, { merchant: "Country Delight", notes: "milk" }),
    txn("b", "2026-09-02", 200, { merchant: "Country Delight", notes: "paneer" }),
    txn("c", "2026-09-03", 900, { category_id: TRAVEL, group_id: "g-goa" }),
  ]);
  const total = (filter: object) =>
    spendSummary(ledger, { period: all, group_by: "none", kind: "expense", filter, limit: 10 }).total;
  assert.equal(total({ category: "food" }), 300);
  assert.equal(total({ category: "FOOD & dining" }), 300);
  assert.equal(total({ group: "goa trip" }), 900);
  assert.equal(total({ text: "country milk" }), 100);
  assert.equal(total({ min_amount: 150, max_amount: 500 }), 200);
  assert.throws(() => total({ category: "nope" }), /Known categories: Food & Dining, Salary, Travel/);
});

test("search_transactions: totals cover every match even when rows are truncated", () => {
  const ledger = ledgerOf([txn("a", "2026-09-01", 100), txn("b", "2026-09-02", 300), txn("c", "2026-09-03", 200)]);
  const r = searchTransactions(ledger, {
    period: all,
    filter: {},
    kind: "expense",
    include_uncounted: false,
    sort: "amount_desc",
    limit: 2,
  });
  assert.equal(r.matched, 3);
  assert.equal(r.spent_total, 600);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.transactions.map((t) => t.amount), [300, 200]);
});

test("search_transactions: uncounted rows appear only when asked, flagged with a status", () => {
  const ledger = ledgerOf([txn("a", "2026-09-01", 100), txn("t", "2026-09-02", 5000, { is_expense: false })]);
  const base = { period: all, filter: {}, kind: "all" as const, sort: "date_asc" as const, limit: 10 };
  assert.equal(searchTransactions(ledger, { ...base, include_uncounted: false }).matched, 1);
  const withAll = searchTransactions(ledger, { ...base, include_uncounted: true });
  assert.equal(withAll.matched, 2);
  assert.equal(withAll.transactions[1].status, "not_counted");
  assert.equal(withAll.spent_total, 100);
});

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

test("budget_status: one-offs are reported, not charged; groups beat categories; remainder catches the rest", () => {
  const ledger = ledgerOf(
    [
      txn("meal", "2026-09-01", 300),
      txn("laptop", "2026-09-02", 50000, { category_id: TRAVEL }),
      txn("goa-dinner", "2026-09-03", 800, { group_id: "g-goa" }),
      txn("taxi", "2026-09-04", 400, { category_id: TRAVEL }),
    ],
    {
      enrichment: [{ transaction_id: "laptop", lending: null, budget_excluded: true, service_identity: null }],
    },
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
  const spent = Object.fromEntries(r.budgets.map((b) => [b.name, b.spent]));
  assert.deepEqual(spent, { Food: 300, Trips: 800, Misc: 400 });
  assert.equal(r.one_offs_excluded, 50000);
  assert.equal(r.ceiling, 8000);
  assert.equal("month_elapsed_pct" in r, false);
});

test("list_debts: repaid is what was linked back to the loan", () => {
  const lent = { type: "lent" as const, counterparty: "Muskan" };
  const ledger = ledgerOf(
    [
      txn("l1", "2026-09-28", 800, { is_expense: false }),
      txn("l2", "2026-10-06", 3000, { is_expense: false }),
      txn("back", "2026-10-01", 400, { is_expense: false }),
    ],
    {
      enrichment: [
        { transaction_id: "l1", lending: lent, budget_excluded: false, service_identity: null },
        { transaction_id: "l2", lending: { ...lent, counterparty: "muskan" }, budget_excluded: false, service_identity: null },
      ],
      refundLinks: [{ original_transaction_id: "l1", refund_transaction_id: "back", linked_amount: 400 }],
    },
  );
  const r = debts(ledger);
  assert.equal(r.people.length, 1);
  assert.equal(r.total_lent, 3800);
  assert.equal(r.total_outstanding, 3400);
  assert.equal(debts(ledger, "nobody").people.length, 0);
});

test("monthlyCost normalises cadence like the app", () => {
  assert.equal(monthlyCost(1200, "annual"), 100);
  assert.equal(monthlyCost(299, "monthly"), 299);
  assert.equal(monthlyCost(100, "weekly"), 429);
  assert.equal(monthlyCost(500, "irregular"), 0);
  assert.equal(monthlyCost(null, "monthly"), 0);
});

test("get_month_review: expand resolves a stored label to its transactions", () => {
  const ledger = ledgerOf([txn("f1", "2026-09-11", 15318, { category_id: TRAVEL, notes: "flight" })]);
  const stored = {
    month: "2026-09",
    highlights: ["Trip"],
    spend_slices: [{ label: "Patna trip", amount: 15318, count: 1, txn_ids: ["f1"] }],
    category_breakdowns: [],
    generated_at: null,
    model: null,
  };
  const r = monthReview(ledger, "2026-09", stored, [], "patna TRIP") as unknown as { expanded: { transactions: { note: string }[] } };
  assert.equal(r.expanded.transactions[0].note, "flight");
  assert.throws(() => monthReview(ledger, "2026-09", stored, [], "nope"), /Labels: Patna trip/);
});
