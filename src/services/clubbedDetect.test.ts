import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeAttributions, noteNamesOtherItems, type Occurrence } from "./clubbedDetect.js";

const occ = (
  id: string,
  note: string | null,
  txnAmount: number,
  over?: Partial<Occurrence>,
): Occurrence => ({
  transactionId: id,
  note,
  txnAmount,
  attributed: txnAmount,
  attributionSetBy: null,
  ...over,
});

// The real ketchup subscription.
const KETCHUP: Occurrence[] = [
  occ("helmet", "Helmet + earphone cover + Ketchup", 2918.55),
  occ("two-x", "2x ketchup", 668.1),
  occ("k1", "Ketchup", 331.55),
  occ("k2", "ketchup", 331.55),
  occ("k3", "Ketchup", 240),
  occ("k4", "ketchup", 387.85),
  occ("mic", "#Online | mic and ketchup", 2812.55),
];

test("proposes only the bundled charges", () => {
  const { proposals, typical } = proposeAttributions(KETCHUP, "ketchup");
  assert.equal(typical, 331.55);
  assert.deepEqual(
    proposals.map((p) => p.transactionId).sort(),
    ["helmet", "mic"],
  );
  assert.equal(proposals.every((p) => p.to === 331.55), true);
});

test("a double purchase of the same item is left alone", () => {
  // "2x ketchup" at roughly twice the usual price is a real double purchase.
  const { proposals } = proposeAttributions(KETCHUP, "ketchup");
  assert.equal(proposals.some((p) => p.transactionId === "two-x"), false);
});

test("never overrules a figure the user set", () => {
  const rows = KETCHUP.map((o) =>
    o.transactionId === "helmet" ? { ...o, attributionSetBy: "manual" } : o,
  );
  const { proposals } = proposeAttributions(rows, "ketchup");
  assert.deepEqual(proposals.map((p) => p.transactionId), ["mic"]);
});

test("never overrules a deliberate full attribution", () => {
  // The user said "count the whole charge". Without attribution_set_by that is
  // indistinguishable from an untouched row, and the pass would undo it nightly.
  const rows = KETCHUP.map((o) =>
    o.transactionId === "mic" ? { ...o, attributionSetBy: "manual" } : o,
  );
  const { proposals } = proposeAttributions(rows, "ketchup");
  assert.deepEqual(proposals.map((p) => p.transactionId), ["helmet"]);
});

test("is idempotent: an already-apportioned row is not proposed again", () => {
  const rows = KETCHUP.map((o) =>
    o.transactionId === "helmet" ? { ...o, attributed: 331.55, attributionSetBy: "routine" } : o,
  );
  const { proposals } = proposeAttributions(rows, "ketchup");
  assert.deepEqual(proposals.map((p) => p.transactionId), ["mic"]);
});

test("ordinary variation is not a bundle", () => {
  const rows = [
    occ("a", "insurance", 1307),
    occ("b", "insurance", 1307.78),
    occ("c", "insurance", 1319.02),
  ];
  assert.deepEqual(proposeAttributions(rows, "insurance").proposals, []);
});

test("catches an outlier on amount alone", () => {
  const rows = [occ("a", "gym", 1000), occ("b", "gym", 1000), occ("c", "gym", 9000)];
  const { proposals } = proposeAttributions(rows, "gym");
  assert.deepEqual(proposals.map((p) => p.transactionId), ["c"]);
  assert.equal(proposals[0].reason, "amount");
});

test("refuses to judge without at least two clean samples", () => {
  const rows = [occ("a", "gym", 500), occ("b", "gym + protein", 9000)];
  assert.deepEqual(proposeAttributions(rows, "gym").proposals, []);
});

test("proposes nothing without a match term", () => {
  assert.deepEqual(proposeAttributions(KETCHUP, null).proposals, []);
});

test("noteNamesOtherItems separates a bundle from a quantity", () => {
  assert.equal(noteNamesOtherItems("mic and ketchup", "ketchup"), true);
  assert.equal(noteNamesOtherItems("2x ketchup", "ketchup"), false);
});
