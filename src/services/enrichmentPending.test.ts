import { test } from "node:test";
import assert from "node:assert/strict";
import { isPending, noteHash } from "./enrichmentPending.js";

const NOTE = "zomato, biryani for two";
const fresh = (over?: Partial<{ note_hash: string; model: string; enriched_at: string }>) => ({
  note_hash: noteHash(NOTE),
  model: "claude-opus-5 (routine)",
  enriched_at: "2026-08-27T21:35:00.000Z",
  ...over,
});

test("a transaction with no enrichment row is pending", () => {
  assert.equal(isPending(NOTE, null), true);
});

test("an up-to-date row is not pending", () => {
  assert.equal(isPending(NOTE, fresh()), false);
});

test("an edited note makes the row pending again", () => {
  assert.equal(isPending("zomato, biryani for three", fresh()), true);
});

test("the hash ignores surrounding whitespace", () => {
  assert.equal(isPending(`  ${NOTE}\n`, fresh()), false);
});

test("relabelBefore re-offers a row enriched before the cutoff", () => {
  // How a field added after the fact gets backfilled: service_identity is null
  // both for "not a service" and for "never asked".
  const old = fresh({ enriched_at: "2026-07-13T10:00:00.000Z" });
  assert.equal(isPending(NOTE, old, "2026-08-01"), true);
});

test("relabelBefore leaves a row enriched after the cutoff alone", () => {
  assert.equal(isPending(NOTE, fresh(), "2026-08-01"), false);
});

test("a manual row is never re-offered, however old", () => {
  // It holds the user's own dismissal or lending mark; the upsert would erase it.
  const manual = fresh({ model: "manual", enriched_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(isPending(NOTE, manual, "2026-08-01"), false);
});

test("a manual row whose note changed is still pending", () => {
  const manual = fresh({ model: "manual" });
  assert.equal(isPending("something else entirely", manual), true);
});

test("an unparsable cutoff does not re-offer the whole table", () => {
  const old = fresh({ enriched_at: "2026-07-13T10:00:00.000Z" });
  assert.equal(isPending(NOTE, old, "last tuesday"), false);
});

test("a cutoff compares as an instant, not as a string", () => {
  // "2026-07-13T10:00:00+05:30" is 04:30Z — before the cutoff despite sorting
  // after it lexicographically.
  const old = fresh({ enriched_at: "2026-07-13T10:00:00+05:30" });
  assert.equal(isPending(NOTE, old, "2026-07-13T06:00:00.000Z"), true);
});
