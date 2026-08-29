import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyEnrichment, EnrichmentSubmissionSchema } from "./enrichmentSubmit.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const offered = new Set([A, B]);
const slugs = new Set(["groceries", "food-dining", "health"]);

const sub = (items: unknown[]) =>
  EnrichmentSubmissionSchema.parse({ model: "claude-opus-5 (routine)", items });

test("accepts a well formed item", () => {
  const v = verifyEnrichment(
    sub([{ id: A, category_suggestion: "groceries", service_identity: null, lending: null }]),
    offered,
    slugs,
  );
  assert.equal(v.errors.length, 0);
  assert.equal(v.accepted.length, 1);
  assert.equal(v.accepted[0].category_suggestion, "groceries");
});

test("refuses an id the server never offered", () => {
  // A stale run must not relabel transactions nobody asked about.
  const v = verifyEnrichment(sub([{ id: C, category_suggestion: "groceries" }]), offered, slugs);
  assert.equal(v.accepted.length, 0);
  assert.match(v.errors[0], /not in the pending set/);
});

test("refuses a category slug that does not exist", () => {
  // The Apply button would have nothing to apply.
  const v = verifyEnrichment(sub([{ id: A, category_suggestion: "not-a-category" }]), offered, slugs);
  assert.equal(v.accepted.length, 0);
  assert.match(v.errors[0], /unknown category slug/);
});

test("matches a slug case insensitively", () => {
  const v = verifyEnrichment(sub([{ id: A, category_suggestion: "Groceries" }]), offered, slugs);
  assert.equal(v.accepted.length, 1);
});

test("drops a duplicate id rather than writing it twice", () => {
  const v = verifyEnrichment(
    sub([{ id: A, category_suggestion: "groceries" }, { id: A, category_suggestion: "health" }]),
    offered,
    slugs,
  );
  assert.equal(v.accepted.length, 1);
  assert.match(v.errors[0], /submitted twice/);
});

test("one bad item does not discard the good ones", () => {
  // Independent per-transaction labels, unlike the review, where the parts must
  // reconcile with each other.
  const v = verifyEnrichment(
    sub([
      { id: A, category_suggestion: "groceries" },
      { id: C, category_suggestion: "groceries" },
      { id: B, service_identity: "youtube premium" },
    ]),
    offered,
    slugs,
  );
  assert.equal(v.accepted.length, 2);
  assert.equal(v.errors.length, 1);
});

test("normalises omitted fields to null so the client reads a stable shape", () => {
  const v = verifyEnrichment(sub([{ id: A }]), offered, slugs);
  assert.deepEqual(v.accepted[0], {
    id: A,
    lending: null,
    category_suggestion: null,
    service_identity: null,
    subscription_id: null,
  });
});

test("the schema rejects a lending entry with no counterparty", () => {
  assert.throws(() =>
    sub([{ id: A, lending: { counterparty: "  ", type: "lent" } }]),
  );
});

test("the schema rejects an unknown lending type", () => {
  assert.throws(() => sub([{ id: A, lending: { counterparty: "mom", type: "gift" } }]));
});

test("an empty submission is valid and accepts nothing", () => {
  const v = verifyEnrichment(sub([]), offered, slugs);
  assert.equal(v.accepted.length, 0);
  assert.equal(v.errors.length, 0);
});

// ─── subscription mapping and suggestion gating ─────────────────────────────

const SUB = "11111111-1111-4111-8111-111111111111";
const TXN = "22222222-2222-4222-8222-222222222222";

const submitItems = (items: unknown[]) =>
  EnrichmentSubmissionSchema.parse({ model: "test", items });

test("a category suggestion on a backfill-only row is dropped, the row still stored", () => {
  const { accepted, errors } = verifyEnrichment(
    submitItems([{ id: TXN, category_suggestion: "groceries", service_identity: "zepto" }]),
    new Set([TXN]),
    new Set(["groceries"]),
    { suggestableIds: new Set() },
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].category_suggestion, null);
  assert.equal(accepted[0].service_identity, "zepto");
  assert.match(errors[0], /offered only for backfill/);
});

test("a category suggestion on a changed row is kept", () => {
  const { accepted, errors } = verifyEnrichment(
    submitItems([{ id: TXN, category_suggestion: "groceries" }]),
    new Set([TXN]),
    new Set(["groceries"]),
    { suggestableIds: new Set([TXN]) },
  );
  assert.deepEqual(errors, []);
  assert.equal(accepted[0].category_suggestion, "groceries");
});

test("a subscription the user does not have is refused outright", () => {
  const { accepted, errors } = verifyEnrichment(
    submitItems([{ id: TXN, subscription_id: SUB }]),
    new Set([TXN]),
    new Set(),
    { knownSubscriptionIds: new Set() },
  );
  assert.equal(accepted.length, 0);
  assert.match(errors[0], /unknown subscription/);
});

test("a real subscription id is carried through", () => {
  const { accepted, errors } = verifyEnrichment(
    submitItems([{ id: TXN, subscription_id: SUB }]),
    new Set([TXN]),
    new Set(),
    { knownSubscriptionIds: new Set([SUB]) },
  );
  assert.deepEqual(errors, []);
  assert.equal(accepted[0].subscription_id, SUB);
});

test("without the gating sets, nothing new is enforced", () => {
  // Older callers pass three arguments; they must keep working unchanged.
  const { accepted, errors } = verifyEnrichment(
    submitItems([{ id: TXN, category_suggestion: "groceries" }]),
    new Set([TXN]),
    new Set(["groceries"]),
  );
  assert.deepEqual(errors, []);
  assert.equal(accepted[0].category_suggestion, "groceries");
});
