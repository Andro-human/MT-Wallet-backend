import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileBreakdowns, type MonthlyCategoryInput } from "./monthlySummary.js";

const food: MonthlyCategoryInput = [
  {
    category: "food",
    name: "Food",
    total: 600,
    items: [
      { n: 1, merchant: "Swiggy", note: "lunch", amount: 200 },
      { n: 2, merchant: "Zomato", note: "dinner", amount: 300 },
      { n: 3, merchant: "KFC", note: null, amount: 100 },
    ],
  },
];

test("code sums group amounts from ordinals — AI never supplies a number", () => {
  const { breakdowns, reconciled } = reconcileBreakdowns(food, [
    {
      category: "food",
      one_liner: "Mostly delivery.",
      groups: [
        { label: "Delivery", ordinals: [1, 2] },
        { label: "Other", ordinals: [3] },
      ],
    },
  ]);
  assert.equal(reconciled, 1);
  assert.equal(breakdowns[0].reconciled, true);
  // biggest-first ordering; amounts summed in code
  assert.deepEqual(
    breakdowns[0].groups.map((g) => [g.label, g.amount, g.count]),
    [
      ["Delivery", 500, 2],
      ["Other", 100, 1],
    ],
  );
});

test("hallucinated (foreign) ordinal → reject → flat fallback", () => {
  const { breakdowns, rejected } = reconcileBreakdowns(food, [
    {
      category: "food",
      one_liner: "x",
      groups: [{ label: "All", ordinals: [1, 2, 3, 99] }],
    },
  ]);
  assert.equal(rejected, 1);
  assert.equal(breakdowns[0].reconciled, false);
  assert.deepEqual(breakdowns[0].groups, []);
  assert.equal(breakdowns[0].total, 600);
});

test("duplicate ordinal → reject (would double-count) → flat fallback", () => {
  const { breakdowns } = reconcileBreakdowns(food, [
    {
      category: "food",
      one_liner: "x",
      groups: [
        { label: "A", ordinals: [1, 2] },
        { label: "B", ordinals: [2, 3] },
      ],
    },
  ]);
  assert.equal(breakdowns[0].reconciled, false);
});

test("incomplete coverage (an item left ungrouped) → reject → flat fallback", () => {
  const { breakdowns } = reconcileBreakdowns(food, [
    {
      category: "food",
      one_liner: "x",
      groups: [{ label: "Some", ordinals: [1, 2] }], // item 3 missing
    },
  ]);
  assert.equal(breakdowns[0].reconciled, false);
});

test("sum mismatch (client total inconsistent with items) → reject → flat fallback", () => {
  const bad: MonthlyCategoryInput = [
    { ...food[0], total: 999 }, // items sum to 600, not 999
  ];
  const { breakdowns } = reconcileBreakdowns(bad, [
    {
      category: "food",
      one_liner: "x",
      groups: [{ label: "All", ordinals: [1, 2, 3] }],
    },
  ]);
  assert.equal(breakdowns[0].reconciled, false);
  assert.equal(breakdowns[0].total, 999);
});

test("AI omits a category entirely → that category flat fallback, others unaffected", () => {
  const two: MonthlyCategoryInput = [
    food[0],
    { category: "bills", name: "Bills", total: 50, items: [{ n: 4, merchant: "X", note: "y", amount: 50 }] },
  ];
  const { breakdowns, reconciled, rejected } = reconcileBreakdowns(two, [
    { category: "food", one_liner: "x", groups: [{ label: "All", ordinals: [1, 2, 3] }] },
  ]);
  assert.equal(reconciled, 1);
  assert.equal(rejected, 1);
  const bills = breakdowns.find((b) => b.category === "bills")!;
  assert.equal(bills.reconciled, false);
  assert.deepEqual(bills.groups, []);
});

test("empty groups from AI → flat fallback", () => {
  const { breakdowns } = reconcileBreakdowns(food, [{ category: "food", one_liner: "x", groups: [] }]);
  assert.equal(breakdowns[0].reconciled, false);
});

test("floating amounts reconcile within tolerance", () => {
  const cents: MonthlyCategoryInput = [
    {
      category: "misc",
      name: "Misc",
      total: 100.03,
      items: [
        { n: 1, merchant: "a", note: null, amount: 33.34 },
        { n: 2, merchant: "b", note: null, amount: 33.34 },
        { n: 3, merchant: "c", note: null, amount: 33.35 },
      ],
    },
  ];
  const { breakdowns } = reconcileBreakdowns(cents, [
    { category: "misc", one_liner: "x", groups: [{ label: "All", ordinals: [1, 2, 3] }] },
  ]);
  assert.equal(breakdowns[0].reconciled, true);
  assert.equal(breakdowns[0].groups[0].amount, 100.03);
});
