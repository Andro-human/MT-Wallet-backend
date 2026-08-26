// Builds the resolved month payload for the AI monthly review.
// Mirrors the frontend exactly: transactionMath netting (refund links, duplicate
// exclusion, is_expense/is_income gating) and the combined Allocation view
// (groups are whole; categories cover UNGROUPED transactions only), so every
// number here matches what the app displays. The AI consumer only groups
// ordinals by meaning — it never computes a number.
//
// Usage: node --env-file=.env scripts/monthly-review-payload.mjs 2026-07 <out.json>
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const MONTH = process.argv[2];
const OUT = process.argv[3];
if (!/^\d{4}-\d{2}$/.test(MONTH ?? "")) {
  console.error("usage: node scripts/monthly-review-payload.mjs YYYY-MM [out.json]");
  process.exit(1);
}

const USER_ID = "b9a63ab5-008d-4afc-966f-bdff975862d5";
const TZ = "Asia/Kolkata";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const istDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const istYearMonth = (iso) => istDate.format(new Date(iso)).slice(0, 7);
const istDay = (iso) => istDate.format(new Date(iso));

async function fetchAll(table, columns, filter = (q) => q, { byUser = true } = {}) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let base = supabase.from(table).select(columns).order("id", { ascending: true });
    if (byUser) base = base.eq("user_id", USER_ID);
    const q = filter(base).range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// Padded UTC window so IST month-edge transactions are never missed.
const [y, m] = MONTH.split("-").map(Number);
const windowStart = new Date(Date.UTC(y, m - 1, 1) - 36 * 3600 * 1000).toISOString();
const windowEnd = new Date(Date.UTC(y, m, 1) + 36 * 3600 * 1000).toISOString();

const [txnsRaw, refundLinks, duplicateLinks, categories, groups] = await Promise.all([
  fetchAll("transactions", "id, amount, merchant, notes, transacted_at, direction, is_expense, is_income, category_id, group_id", (q) =>
    q.gte("transacted_at", windowStart).lte("transacted_at", windowEnd),
  ),
  fetchAll("refund_links", "original_transaction_id, refund_transaction_id, linked_amount"),
  fetchAll("duplicate_links", "duplicate_transaction_id"),
  fetchAll("categories", "id, name, slug", (q) => q, { byUser: false }),
  fetchAll("transaction_groups", "id, name"),
]);

const refundTotals = {};
const refundAllocations = {};
for (const l of refundLinks) {
  const amt = Number(l.linked_amount ?? 0);
  if (!amt) continue;
  refundTotals[l.original_transaction_id] = (refundTotals[l.original_transaction_id] || 0) + amt;
  refundAllocations[l.refund_transaction_id] = (refundAllocations[l.refund_transaction_id] || 0) + amt;
}
const duplicateExcludeIds = new Set(duplicateLinks.map((l) => l.duplicate_transaction_id));
const catById = new Map(categories.map((c) => [c.id, c]));
const groupById = new Map(groups.map((g) => [g.id, g]));

const monthTxns = txnsRaw.filter((t) => istYearMonth(t.transacted_at) === MONTH);

const round2 = (n) => Math.round(n * 100) / 100;

const itemsByKey = new Map();
const incomeLines = [];
const skipped = { duplicates: 0, fullyRefunded: 0, notCounted: 0, notCountedAmount: 0 };
let totalSpent = 0;
let totalIncome = 0;
let n = 0;

for (const t of monthTxns) {
  if (duplicateExcludeIds.has(t.id)) {
    skipped.duplicates++;
    continue;
  }
  const amount = Number(t.amount);

  if (t.is_income) {
    const net = round2(Math.max(amount - (refundAllocations[t.id] ?? 0), 0));
    if (net > 0) {
      totalIncome = round2(totalIncome + net);
      incomeLines.push({ d: istDay(t.transacted_at), merchant: t.merchant, note: t.notes, amount: net });
    }
  }

  if (!t.is_expense) {
    if (!t.is_income) {
      skipped.notCounted++;
      skipped.notCountedAmount = round2(skipped.notCountedAmount + (t.direction !== "credit" ? amount : 0));
    }
    continue;
  }

  const net = round2(Math.max(amount - (refundTotals[t.id] ?? 0), 0));
  if (net <= 0) {
    skipped.fullyRefunded++;
    continue;
  }
  totalSpent = round2(totalSpent + net);

  let key, kind, name, slug;
  if (t.group_id) {
    key = `group:${t.group_id}`;
    kind = "group";
    name = groupById.get(t.group_id)?.name ?? "Unknown Group";
    slug = null;
  } else {
    const cat = t.category_id ? catById.get(t.category_id) : null;
    key = `cat:${t.category_id ?? "uncategorized"}`;
    kind = "category";
    name = cat?.name ?? "Uncategorized";
    slug = cat?.slug ?? "uncategorized";
  }

  const item = itemsByKey.get(key) ?? { key, kind, name, slug, total: 0, txns: [] };
  n += 1;
  item.txns.push({
    n,
    d: istDay(t.transacted_at),
    merchant: t.merchant ?? null,
    note: t.notes ?? null,
    amount: net,
    refunded: refundTotals[t.id] ? round2(refundTotals[t.id]) : undefined,
  });
  item.total = round2(item.total + net);
  itemsByKey.set(key, item);
}

const items = [...itemsByKey.values()].sort((a, b) => b.total - a.total);
incomeLines.sort((a, b) => b.amount - a.amount);

const payload = {
  month: MONTH,
  user_id: USER_ID,
  timezone: TZ,
  totals: { spent: totalSpent, income: totalIncome },
  items,
  income_lines: incomeLines,
  excluded: skipped,
};

const summaryLine = items
  .map((i) => `${i.kind === "group" ? "[G] " : ""}${i.name}: ₹${i.total} (${i.txns.length})`)
  .join("\n  ");
console.log(
  `${MONTH}: spent ₹${totalSpent} across ${n} txns, income ₹${totalIncome} (${incomeLines.length} credits)\n` +
    `excluded: ${skipped.duplicates} duplicates, ${skipped.fullyRefunded} fully refunded, ` +
    `${skipped.notCounted} not-counted (₹${skipped.notCountedAmount} debit volume)\n  ${summaryLine}`,
);

if (OUT) {
  writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log(`\nwrote ${OUT}`);
}
