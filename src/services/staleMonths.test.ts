import { test } from "node:test";
import assert from "node:assert/strict";
import { monthsBefore, statusOf } from "./staleMonths.js";
import type { ReviewPayload } from "./monthlyReview.js";

test("the window is the months before the current one, never the current one", () => {
  assert.deepEqual(monthsBefore("2026-08", 3), ["2026-07", "2026-06", "2026-05"]);
});

test("the window crosses a year boundary", () => {
  assert.deepEqual(monthsBefore("2026-02", 3), ["2026-01", "2025-12", "2025-11"]);
});

const payload = (
  items: { needs_regen: boolean }[],
  days: { needs_summary: boolean }[] = [],
): ReviewPayload =>
  ({
    month: "2026-07",
    timezone: "Asia/Kolkata",
    totals: { spent: 0, income: 0 },
    items: items.map((i, n) => ({
      key: `cat:${n}`,
      kind: "category",
      name: `C${n}`,
      slug: `c${n}`,
      total: 100,
      fingerprint: `fp${n}`,
      needs_regen: i.needs_regen,
      txns: [],
    })),
    days: days.map((d, n) => ({
      day: `2026-07-0${n + 1}`,
      total: 100,
      all_noted: true,
      notes_fingerprint: `d${n}`,
      has_summary: false,
      summary_stale: false,
      summary_locked: false,
      needs_summary: d.needs_summary,
      txns: [],
    })),
    income_lines: [],
    excluded: { duplicates: 0, fullyRefunded: 0, notCounted: 0 },
    known_slice_labels: [],
    known_group_labels: [],
  }) as ReviewPayload;

test("a settled month needs no work", () => {
  const s = statusOf("2026-07", payload([{ needs_regen: false }], [{ needs_summary: false }]), true);
  assert.equal(s.needs_work, false);
});

test("a late refund on one category reopens the month", () => {
  // July's AirPods line survived a refund that landed in August.
  const s = statusOf("2026-07", payload([{ needs_regen: true }, { needs_regen: false }]), true);
  assert.equal(s.needs_work, true);
  assert.equal(s.items_stale, 1);
  assert.equal(s.items_total, 2);
});

test("a day left unsummarised reopens the month on its own", () => {
  const s = statusOf("2026-07", payload([{ needs_regen: false }], [{ needs_summary: true }]), true);
  assert.equal(s.needs_work, true);
  assert.equal(s.days_stale, 1);
});

test("a month with no spend is never flagged, review row or not", () => {
  assert.equal(statusOf("2020-01", payload([]), false).needs_work, false);
});
