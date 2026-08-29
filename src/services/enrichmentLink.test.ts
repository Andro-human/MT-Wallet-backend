import { test } from "node:test";
import assert from "node:assert/strict";
import { planLinks } from "./enrichmentLink.js";

const NETFLIX = "sub-netflix";
const PRIME = "sub-prime";
const req = (transactionId: string, subscriptionId: string) => ({ transactionId, subscriptionId });

test("an unlinked transaction is linked", () => {
  const { insert, skipped } = planLinks([req("t1", NETFLIX)], new Map(), new Set());
  assert.deepEqual(insert, [req("t1", NETFLIX)]);
  assert.deepEqual(skipped, []);
});

test("a transaction already on that subscription is a no-op, not an error", () => {
  const { insert, skipped } = planLinks(
    [req("t1", NETFLIX)],
    new Map([["t1", NETFLIX]]),
    new Set(),
  );
  assert.deepEqual(insert, []);
  assert.deepEqual(skipped, []);
});

test("a transaction linked elsewhere is left alone", () => {
  // The user may have moved this deliberately. A nightly run that reassigned it
  // would undo that silently, every night, forever.
  const { insert, skipped } = planLinks([req("t1", NETFLIX)], new Map([["t1", PRIME]]), new Set());
  assert.deepEqual(insert, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /already linked to another/);
});

test("a hand-made link says so, because that is the one worth telling the user about", () => {
  const { skipped } = planLinks([req("t1", NETFLIX)], new Map([["t1", PRIME]]), new Set(["t1"]));
  assert.match(skipped[0].reason, /by hand/);
});

test("a mixed batch links what it can and reports the rest", () => {
  const { insert, skipped } = planLinks(
    [req("t1", NETFLIX), req("t2", NETFLIX), req("t3", PRIME)],
    new Map([["t2", PRIME]]),
    new Set(),
  );
  assert.deepEqual(
    insert.map((i) => i.transactionId),
    ["t1", "t3"],
  );
  assert.deepEqual(skipped.map((s) => s.transactionId), ["t2"]);
});

test("an empty batch plans nothing", () => {
  assert.deepEqual(planLinks([], new Map(), new Set()), { insert: [], skipped: [] });
});
