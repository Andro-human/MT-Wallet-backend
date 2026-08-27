// Reconciles AI groupings against the resolved month payload and stores the
// review. Code owns every rupee: group amounts are summed here from the
// referenced ordinals. An item is accepted only if every transaction is
// covered exactly once, no foreign/duplicate ordinals appear, and the group
// sums match the item total. Any violation fails the whole run (the agent
// fixes its groupings and reruns — no silent flat-total degradation).
//
// check:  node --env-file=.env scripts/monthly-review-store.mjs check <payload.json> <groupings.json>
// upsert: node --env-file=.env scripts/monthly-review-store.mjs upsert <payload.json> <groupings.json> <review.json>
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const [mode, payloadPath, groupingsPath, reviewPath] = process.argv.slice(2);
if (!["check", "upsert"].includes(mode) || !payloadPath || !groupingsPath || (mode === "upsert" && !reviewPath)) {
  console.error("usage: monthly-review-store.mjs check|upsert <payload.json> <groupings.json> [review.json]");
  process.exit(1);
}

const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
const groupings = JSON.parse(readFileSync(groupingsPath, "utf8"));

const round2 = (n) => Math.round(n * 100) / 100;
const errors = [];
const breakdowns = [];

const groupingByKey = new Map(groupings.items.map((i) => [i.key, i]));
for (const g of groupings.items) {
  if (!payload.items.some((it) => it.key === g.key)) errors.push(`grouping for unknown item ${g.key}`);
}

for (const item of payload.items) {
  const grouping = groupingByKey.get(item.key);
  if (!grouping) {
    errors.push(`${item.name} (${item.key}): no grouping provided`);
    continue;
  }
  const amountByN = new Map(item.txns.map((t) => [t.n, t.amount]));
  const seen = new Set();
  const groups = [];
  for (const g of grouping.groups) {
    let sum = 0;
    let count = 0;
    for (const o of g.ordinals) {
      if (!amountByN.has(o)) {
        errors.push(`${item.name}: ordinal ${o} in "${g.label}" is not in this item`);
        continue;
      }
      if (seen.has(o)) {
        errors.push(`${item.name}: ordinal ${o} appears twice`);
        continue;
      }
      seen.add(o);
      sum = round2(sum + amountByN.get(o));
      count++;
    }
    if (count > 0) groups.push({ label: g.label, amount: round2(sum), count });
  }
  if (seen.size !== item.txns.length) {
    const missing = item.txns.filter((t) => !seen.has(t.n)).map((t) => t.n);
    errors.push(`${item.name}: ordinals not covered: ${missing.join(", ")}`);
  }
  const groupSum = round2(groups.reduce((s, g) => s + g.amount, 0));
  if (Math.abs(groupSum - item.total) >= 0.01) {
    errors.push(`${item.name}: group sum ₹${groupSum} != item total ₹${item.total}`);
  }
  groups.sort((a, b) => b.amount - a.amount);
  breakdowns.push({
    category: item.kind === "group" ? item.key : item.slug,
    name: item.name,
    total: round2(item.total),
    one_liner: grouping.one_liner ?? null,
    groups,
    reconciled: true,
  });
}

// Month-global slices: a second, cross-item partition of the SAME ordinals,
// used for the "where the month went" pie. Must cover every expense ordinal
// in the month exactly once and sum to totals.spent.
const allTxnByN = new Map(payload.items.flatMap((it) => it.txns.map((t) => [t.n, t])));
const slices = [];
if (Array.isArray(groupings.slices) && groupings.slices.length > 0) {
  const seen = new Set();
  for (const s of groupings.slices) {
    let sum = 0;
    let count = 0;
    for (const o of s.ordinals) {
      if (!allTxnByN.has(o)) {
        errors.push(`slice "${s.label}": ordinal ${o} does not exist this month`);
        continue;
      }
      if (seen.has(o)) {
        errors.push(`slice "${s.label}": ordinal ${o} appears in two slices`);
        continue;
      }
      seen.add(o);
      sum = round2(sum + allTxnByN.get(o).amount);
      count++;
    }
    if (count > 0) slices.push({ label: s.label, amount: round2(sum), count });
  }
  if (seen.size !== allTxnByN.size) {
    const missing = [...allTxnByN.keys()].filter((n) => !seen.has(n));
    errors.push(`slices: ordinals not covered: ${missing.join(", ")}`);
  }
  const sliceSum = round2(slices.reduce((s, g) => s + g.amount, 0));
  if (Math.abs(sliceSum - payload.totals.spent) >= 0.01) {
    errors.push(`slices: sum ₹${sliceSum} != total spent ₹${payload.totals.spent}`);
  }
  slices.sort((a, b) => b.amount - a.amount);
}

if (errors.length > 0) {
  console.error(`RECONCILIATION FAILED (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(2);
}

console.log(`reconciled ${breakdowns.length}/${payload.items.length} items, all sums match\n`);
for (const b of breakdowns) {
  console.log(`${b.name} — ₹${b.total}`);
  for (const g of b.groups) console.log(`   ${g.label}: ₹${g.amount} (${g.count})`);
}
if (slices.length > 0) {
  console.log(`\nmonth slices (sum = ₹${payload.totals.spent}):`);
  for (const s of slices) console.log(`   ${s.label}: ₹${s.amount} (${s.count})`);
}

if (mode === "upsert") {
  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  if (!review.summary || !Array.isArray(review.highlights) || review.highlights.length < 2) {
    console.error("review.json needs { summary, highlights[>=2] }");
    process.exit(2);
  }

  const aggregates = {
    month: payload.month,
    total_spent: Math.round(payload.totals.spent),
    total_income: Math.round(payload.totals.income),
    allocations: payload.items
      .slice(0, 10)
      .map((i) => ({ name: i.name, amount: Math.round(i.total), type: i.kind })),
    top_sub_themes: breakdowns
      .flatMap((b) => b.groups.map((g) => ({ context: b.name, label: g.label, amount: Math.round(g.amount) })))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10),
    recurring_monthly_committed: review.recurring_monthly_committed ?? null,
    loans_outstanding: review.loans_outstanding ?? null,
  };

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await supabase.from("monthly_summaries").upsert({
    user_id: payload.user_id,
    month: payload.month,
    summary: review.summary,
    highlights: review.highlights,
    aggregates,
    category_breakdowns: breakdowns,
    spend_slices: slices,
    usage: { input: 0, output: 0, reasoning: 0 },
    model: review.model ?? "claude-code-agent",
    generated_at: new Date().toISOString(),
  });
  if (error) {
    console.error(`upsert failed: ${error.message}`);
    process.exit(2);
  }
  console.log(`\nstored ${payload.month} review for ${payload.user_id} (model: ${review.model ?? "claude-code-agent"})`);
}
