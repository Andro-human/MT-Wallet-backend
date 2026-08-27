import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconcilePartition,
  reconcileSubmission,
  reconcileDays,
  daySummaryStatus,
  ReviewSubmissionSchema,
  type ReviewPayload,
} from "./monthlyReview.js";

const txns = new Map<number, number>([
  [1, 100],
  [2, 50.5],
  [3, 49.5],
]);

test("accepts a full, exact partition", () => {
  const errors: string[] = [];
  const groups = reconcilePartition(
    "Health",
    txns,
    [
      { label: "A", ordinals: [1] },
      { label: "B", ordinals: [2, 3] },
    ],
    200,
    errors,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(groups, [
    { label: "A", amount: 100, count: 1 },
    { label: "B", amount: 100, count: 2 },
  ]);
});

test("rejects missing coverage", () => {
  const errors: string[] = [];
  reconcilePartition("Health", txns, [{ label: "A", ordinals: [1, 2] }], 200, errors);
  assert.ok(errors.some((e) => e.includes("not covered: 3")));
  assert.ok(errors.some((e) => e.includes("!= expected total")));
});

test("rejects foreign ordinals", () => {
  const errors: string[] = [];
  reconcilePartition("Health", txns, [{ label: "A", ordinals: [1, 2, 3, 99] }], 200, errors);
  assert.ok(errors.some((e) => e.includes("ordinal 99")));
});

test("rejects double assignment", () => {
  const errors: string[] = [];
  reconcilePartition(
    "Health",
    txns,
    [
      { label: "A", ordinals: [1, 2] },
      { label: "B", ordinals: [2, 3] },
    ],
    200,
    errors,
  );
  assert.ok(errors.some((e) => e.includes("assigned twice")));
});

test("rejects sum drift beyond a paisa", () => {
  const errors: string[] = [];
  reconcilePartition(
    "Health",
    txns,
    [
      { label: "A", ordinals: [1] },
      { label: "B", ordinals: [2, 3] },
    ],
    200.02,
    errors,
  );
  assert.ok(errors.some((e) => e.includes("!= expected total")));
});

test("float-heavy amounts reconcile at 2dp", () => {
  const floaty = new Map<number, number>([
    [1, 0.1],
    [2, 0.2],
    [3, 0.3],
  ]);
  const errors: string[] = [];
  const groups = reconcilePartition("F", floaty, [{ label: "all", ordinals: [1, 2, 3] }], 0.6, errors);
  assert.deepEqual(errors, []);
  assert.equal(groups[0].amount, 0.6);
});

test("error list is capped", () => {
  const errors: string[] = [];
  const foreign = Array.from({ length: 200 }, (_, i) => 1000 + i);
  reconcilePartition("Big", txns, [{ label: "A", ordinals: foreign }], 200, errors);
  assert.ok(errors.length <= 51);
  assert.ok(errors.some((e) => e.includes("truncated")));
});

function makePayload(): ReviewPayload {
  return {
    month: "2026-07",
    timezone: "Asia/Kolkata",
    totals: { spent: 200, income: 0 },
    items: [
      {
        key: "cat:a",
        kind: "category",
        name: "A",
        slug: "a",
        total: 100,
        txns: [{ n: 1, d: "2026-07-01", merchant: null, note: null, amount: 100 }],
      },
      {
        key: "group:b",
        kind: "group",
        name: "B",
        slug: null,
        total: 100,
        txns: [{ n: 2, d: "2026-07-02", merchant: null, note: null, amount: 100 }],
      },
    ],
    income_lines: [],
    excluded: { duplicates: 0, fullyRefunded: 0, notCounted: 0 },
    known_slice_labels: [],
    known_group_labels: [],
  };
}

const submit = (over: Record<string, unknown>) =>
  ReviewSubmissionSchema.parse({
    month: "2026-07",
    review: { summary: "s", highlights: ["a", "b"] },
    items: [
      { key: "cat:a", groups: [{ label: "x", ordinals: [1] }] },
      { key: "group:b", groups: [{ label: "y", ordinals: [2] }] },
    ],
    ...over,
  });

test("full submission reconciles: breakdowns keyed by slug/group-key, slices optional", () => {
  const r = reconcileSubmission(makePayload(), submit({}));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(
    r.breakdowns.map((b) => b.category),
    ["a", "group:b"],
  );
  assert.deepEqual(r.slices, []);
});

test("rejects unknown and missing item keys", () => {
  const r = reconcileSubmission(
    makePayload(),
    submit({ items: [{ key: "cat:bogus", groups: [{ label: "x", ordinals: [1] }] }] }),
  );
  assert.ok(r.errors.some((e) => e.includes("unknown item key cat:bogus")));
  assert.ok(r.errors.some((e) => e.includes("A (cat:a): no grouping submitted")));
  assert.ok(r.errors.some((e) => e.includes("B (group:b): no grouping submitted")));
});

test("rejects duplicate submission keys instead of silently dropping one", () => {
  const r = reconcileSubmission(
    makePayload(),
    submit({
      items: [
        { key: "cat:a", groups: [{ label: "x", ordinals: [1] }] },
        { key: "cat:a", groups: [{ label: "x2", ordinals: [1] }] },
        { key: "group:b", groups: [{ label: "y", ordinals: [2] }] },
      ],
    }),
  );
  assert.ok(r.errors.some((e) => e.includes("duplicate item keys")));
});

test("slices reconcile across ALL items and must sum to total spent", () => {
  const good = reconcileSubmission(makePayload(), submit({ slices: [{ label: "all", ordinals: [1, 2] }] }));
  assert.deepEqual(good.errors, []);
  assert.equal(good.slices[0].amount, 200);

  const partial = reconcileSubmission(makePayload(), submit({ slices: [{ label: "half", ordinals: [1] }] }));
  assert.ok(partial.errors.some((e) => e.includes("slices: ordinals not covered: 2")));
});

test("zero-expense month: empty items reconcile cleanly", () => {
  const empty: ReviewPayload = { ...makePayload(), totals: { spent: 0, income: 500 }, items: [] };
  const r = reconcileSubmission(empty, submit({ items: [] }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.breakdowns, []);
});

// ─── Day summaries ──────────────────────────────────────────────────────────

const dayPayload = (over: Partial<ReviewPayload["days"][number]> = {}): ReviewPayload => ({
  month: "2026-08",
  timezone: "Asia/Kolkata",
  totals: { spent: 300, income: 0 },
  items: [],
  days: [
    {
      day: "2026-08-20",
      total: 300,
      all_noted: true,
      notes_fingerprint: "abc123",
      txns: [
        { n: 1, d: "2026-08-20", merchant: "Zomato", note: "lunch", amount: 200 },
        { n: 2, d: "2026-08-20", merchant: "Zepto", note: "milk", amount: 100 },
      ],
      ...over,
    },
  ],
  income_lines: [],
  excluded: { duplicates: 0, fullyRefunded: 0, notCounted: 0 },
  known_slice_labels: [],
  known_group_labels: [],
});

const daySubmission = (summary: string, groups?: any) => ({
  month: "2026-08",
  review: { summary: "x", highlights: ["a", "b"], model: "test" },
  items: [],
  slices: [],
  days: [
    {
      day: "2026-08-20",
      summary,
      groups: groups ?? [
        { label: "Food delivery", ordinals: [1] },
        { label: "Groceries", ordinals: [2] },
      ],
    },
  ],
});

test("day: accepts a reconciling partition with figures the server computed", () => {
  const errors: string[] = [];
  const days = reconcileDays(dayPayload(), daySubmission("Food delivery ₹200. Groceries ₹100.") as any, errors);
  assert.deepEqual(errors, []);
  assert.equal(days.length, 1);
  assert.equal(days[0].notes_fingerprint, "abc123");
  assert.deepEqual(days[0].groups.map((g) => g.amount), [200, 100]);
});

test("day: rejects a figure the agent invented", () => {
  const errors: string[] = [];
  const days = reconcileDays(dayPayload(), daySubmission("Food delivery ₹250. Groceries ₹100.") as any, errors);
  assert.equal(days.length, 0);
  assert.ok(errors.some((e) => e.includes("₹250")), errors.join(" | "));
});

test("day: accepts the day total and a bare transaction amount as figures", () => {
  const errors: string[] = [];
  const days = reconcileDays(dayPayload(), daySubmission("Rs300 in all, Rs200 of it delivery.") as any, errors);
  assert.deepEqual(errors, []);
  assert.equal(days.length, 1);
});

test("day: refuses a day that is not fully noted", () => {
  const errors: string[] = [];
  const days = reconcileDays(dayPayload({ all_noted: false }), daySubmission("Food delivery ₹200. Groceries ₹100.") as any, errors);
  assert.equal(days.length, 0);
  assert.ok(errors.some((e) => e.includes("noted")), errors.join(" | "));
});

test("day: refuses groups that do not cover the day", () => {
  const errors: string[] = [];
  const days = reconcileDays(
    dayPayload(),
    daySubmission("Food delivery ₹200.", [{ label: "Food delivery", ordinals: [1] }]) as any,
    errors,
  );
  assert.equal(days.length, 0);
  assert.ok(errors.some((e) => e.includes("not covered")), errors.join(" | "));
});

test("day: refuses an unknown date", () => {
  const errors: string[] = [];
  const sub = daySubmission("Food delivery ₹200. Groceries ₹100.") as any;
  sub.days[0].day = "2026-08-19";
  const days = reconcileDays(dayPayload(), sub, errors);
  assert.equal(days.length, 0);
  assert.ok(errors.some((e) => e.includes("not in this month")), errors.join(" | "));
});

// ─── day summary backfill / staleness ────────────────────────────────────────

test("day status: a fully noted day with no summary is written", () => {
  const s = daySummaryStatus(true, "abc123", undefined);
  assert.equal(s.has_summary, false);
  assert.equal(s.needs_summary, true);
});

test("day status: a day that is not fully noted is never written", () => {
  // 26 Aug 2026 sat here: a Rs 17.98 Zomato charge carried no note.
  assert.equal(daySummaryStatus(false, "abc123", undefined).needs_summary, false);
  assert.equal(
    daySummaryStatus(false, "new", { notes_fingerprint: "old", model: "gemini" }).needs_summary,
    false,
  );
});

test("day status: an unchanged day is left alone", () => {
  const s = daySummaryStatus(true, "abc123", { notes_fingerprint: "abc123", model: "gemini" });
  assert.equal(s.summary_stale, false);
  assert.equal(s.needs_summary, false);
});

test("day status: a changed note or a late refund reopens the day", () => {
  const s = daySummaryStatus(true, "NEW", { notes_fingerprint: "OLD", model: "gemini" });
  assert.equal(s.summary_stale, true);
  assert.equal(s.needs_summary, true);
});

test("day status: hand-written days are never reopened, even when stale", () => {
  const s = daySummaryStatus(true, "NEW", { notes_fingerprint: "OLD", model: "manual" });
  assert.equal(s.summary_locked, true);
  assert.equal(s.summary_stale, true);
  assert.equal(s.needs_summary, false);
});

test("day status: a stored row with a null fingerprint counts as stale", () => {
  // Rows written before the fingerprint column existed.
  const s = daySummaryStatus(true, "abc123", { notes_fingerprint: null, model: "gemini" });
  assert.equal(s.needs_summary, true);
});
