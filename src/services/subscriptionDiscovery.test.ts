import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignOrdinals,
  isCandidate,
  resolveProposals,
  ProposalSubmissionSchema,
  type DiscoveryMerchant,
} from "./subscriptionDiscovery.js";
import { scoreCluster } from "./proposalMath.js";

// ─── candidate filter ───────────────────────────────────────────────────────

test("a credit is never a subscription charge", () => {
  assert.equal(isCandidate({ direction: "credit", merchant: "Netflix", is_expense: true }), false);
});

test("a row that does not count as spend is skipped", () => {
  assert.equal(isCandidate({ direction: "debit", merchant: "Netflix", is_expense: false }), false);
});

test("rail noise is not a payee", () => {
  assert.equal(isCandidate({ direction: "debit", merchant: "UPI", is_expense: true }), false);
  assert.equal(isCandidate({ direction: "debit", merchant: "someone@okhdfc", is_expense: true }), false);
  assert.equal(isCandidate({ direction: "debit", merchant: "", is_expense: true }), false);
});

test("an ordinary merchant is a candidate", () => {
  assert.equal(isCandidate({ direction: "debit", merchant: "Netflix", is_expense: true }), true);
});

// ─── ordinals ───────────────────────────────────────────────────────────────

const t = (id: string, merchant: string, d: string) => ({ id, merchant, transacted_at: d });

test("ordinals are assigned by merchant then date, so a rebuild matches", () => {
  const rows = [t("c", "Zomato", "2026-03-01"), t("a", "Netflix", "2026-02-01"), t("b", "Netflix", "2026-01-01")];
  const first = assignOrdinals(rows);
  const second = assignOrdinals([...rows].reverse());
  assert.deepEqual(
    first.map((g) => [g.merchant, g.rows.map((r) => [r.n, r.id])]),
    second.map((g) => [g.merchant, g.rows.map((r) => [r.n, r.id])]),
  );
  assert.deepEqual(first[0].rows.map((r) => r.id), ["b", "a"]);
});

test("same-instant rows are ordered by id rather than left to chance", () => {
  const g = assignOrdinals([t("z", "Netflix", "2026-01-01"), t("a", "Netflix", "2026-01-01")]);
  assert.deepEqual(g[0].rows.map((r) => r.id), ["a", "z"]);
});

// ─── cluster scoring ────────────────────────────────────────────────────────

const NOW = new Date("2026-08-29T00:00:00Z");
const monthly = (n: number, amount = 199) =>
  Array.from({ length: n }, (_, i) => ({
    amount,
    transacted_at: `2026-0${i + 1}-05`,
  }));

test("a monthly charge scores as monthly", () => {
  const s = scoreCluster(monthly(6), NOW)!;
  assert.equal(s.cadence, "monthly");
  assert.equal(s.median_amount, 199);
  assert.equal(s.occurrences, 6);
  assert.equal(s.predicted_next.slice(0, 7), "2026-07");
});

test("two occurrences are not a pattern", () => {
  assert.equal(scoreCluster(monthly(2), NOW), null);
});

test("same-week spend is refused however often it repeats", () => {
  // Daily Swiggy orders are not a subscription.
  const daily = Array.from({ length: 10 }, (_, i) => ({
    amount: 250,
    transacted_at: `2026-08-${String(i + 1).padStart(2, "0")}`,
  }));
  assert.equal(scoreCluster(daily, NOW), null);
});

test("the stored amount is the median, so one combined order cannot move it", () => {
  const rows = monthly(5);
  rows[2].amount = 4000;
  assert.equal(scoreCluster(rows, NOW)!.median_amount, 199);
});

// ─── proposal resolution ────────────────────────────────────────────────────

const payload = (): { merchants: DiscoveryMerchant[] } => ({
  merchants: [
    {
      m: "netflix",
      txns: monthly(6).map((r, i) => ({ n: i + 1, d: r.transacted_at, amount: r.amount })),
    },
    {
      m: "zomato",
      txns: [
        { n: 7, d: "2026-08-01", amount: 300 },
        { n: 8, d: "2026-08-02", amount: 250 },
        { n: 9, d: "2026-08-03", amount: 400 },
      ],
    },
  ],
});

const submit = (proposals: unknown[]) =>
  ProposalSubmissionSchema.parse({ proposals, window: 24 });

test("a well-formed proposal is scored and kept", () => {
  const { rows, outcomes } = resolveProposals(
    payload(),
    submit([{ label: "Netflix", ordinals: [1, 2, 3, 4, 5, 6] }]),
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Netflix");
  assert.equal(rows[0].cadence, "monthly");
  assert.deepEqual(outcomes, [{ label: "Netflix", stored: true }]);
});

test("a proposal naming an ordinal that is not in the payload is refused", () => {
  const { rows, outcomes } = resolveProposals(
    payload(),
    submit([{ label: "Ghost", ordinals: [1, 2, 99] }]),
    NOW,
  );
  assert.equal(rows.length, 0);
  assert.match(outcomes[0].reason!, /unknown ordinals: 99/);
});

test("a transaction cannot belong to two proposals", () => {
  const { rows, outcomes } = resolveProposals(
    payload(),
    submit([
      { label: "Netflix", ordinals: [1, 2, 3, 4, 5, 6] },
      { label: "Netflix again", ordinals: [1, 2, 3] },
    ]),
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.match(outcomes[1].reason!, /already claimed/);
});

test("a cluster that does not recur is refused, not stored with a made-up cadence", () => {
  const { rows, outcomes } = resolveProposals(
    payload(),
    submit([{ label: "Zomato", ordinals: [7, 8, 9] }]),
    NOW,
  );
  assert.equal(rows.length, 0);
  assert.match(outcomes[0].reason!, /do not recur/);
});

test("a repeated ordinal within one proposal is counted once", () => {
  const { rows } = resolveProposals(
    payload(),
    submit([{ label: "Netflix", ordinals: [1, 1, 2, 3, 4, 5, 6] }]),
    NOW,
  );
  assert.equal(rows[0].occurrences, 6);
});

test("an empty submission stores nothing and errors on nothing", () => {
  const { rows, outcomes } = resolveProposals(payload(), submit([]), NOW);
  assert.deepEqual(rows, []);
  assert.deepEqual(outcomes, []);
});

test("fewer than three ordinals is rejected at the schema, before any scoring", () => {
  assert.throws(() => submit([{ label: "Netflix", ordinals: [1, 2] }]));
});

test("a submission without the window it was read against is rejected", () => {
  // Ordinals are positions in a window. Defaulting one here would silently
  // link whichever transactions happen to sit at those positions today.
  assert.throws(() =>
    ProposalSubmissionSchema.parse({ proposals: [{ label: "X", ordinals: [1, 2, 3] }] }),
  );
});
