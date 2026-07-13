/**
 * Enrichment backfill (Layer B, Task 3).
 *
 * Selects noted transactions that are unenriched (no txn_enrichment row, or
 * note edited since — note_hash mismatch), batches them through
 * enrichTransactions, and upserts results PER BATCH so a crash keeps
 * everything already done. Hard-stops on both a txn count and a spend
 * ceiling — the two guards whose absence made the Jul 2026 full-history run
 * burn ~₹46 producing nothing.
 *
 * Usage:
 *   npx tsx scripts/enrich-backfill.ts --limit 30 --spread --exclude cat,health
 *   npx tsx scripts/enrich-backfill.ts --limit 30 --model gemini-2.5-flash-lite --no-persist
 *   npx tsx scripts/enrich-backfill.ts --dry-run
 *
 * Flags:
 *   --limit N          max txns this run (default 50)
 *   --batch-size N     txns per AI call (default 30)
 *   --model ID         gemini model (default gemini-2.5-flash)
 *   --max-rupees X     spend ceiling for this run (default 5)
 *   --spread           sample evenly across categories instead of newest-first
 *   --exclude a,b      category slugs to skip
 *   --only a,b         restrict to these category slugs
 *   --dry-run          print the selection and exit (no AI calls)
 *   --no-persist       run the AI but don't write txn_enrichment (A/B probes)
 */
import "dotenv/config";
import { supabase } from "../src/services/supabase.js";
import { enrichTransactions, type EnrichInput } from "../src/services/enrichment.js";
import { noteHash, loadVocabulary, costRupees } from "../src/services/enrichmentJob.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const LIMIT = Number(arg("limit") ?? 50);
const BATCH_SIZE = Number(arg("batch-size") ?? 30);
const MODEL = arg("model") ?? "gemini-2.5-flash";
const MAX_RUPEES = Number(arg("max-rupees") ?? 5);
const SPREAD = flag("spread");
const EXCLUDE = (arg("exclude") ?? "").split(",").filter(Boolean);
const ONLY = (arg("only") ?? "").split(",").filter(Boolean);
const DRY_RUN = flag("dry-run");
const NO_PERSIST = flag("no-persist");

type Row = {
  id: string;
  user_id: string;
  notes: string;
  merchant: string | null;
  amount: number;
  category: string;
};

async function selectPending(): Promise<Row[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select("id, user_id, notes, merchant, amount, transacted_at, categories(slug), txn_enrichment(note_hash)")
    .not("notes", "is", null)
    .neq("notes", "")
    .order("transacted_at", { ascending: false })
    .limit(5000);
  if (error) throw new Error(`select failed: ${error.message}`);

  const rows: Row[] = [];
  for (const t of data ?? []) {
    const note = (t.notes ?? "").trim();
    if (!note) continue;
    const category = (t.categories as unknown as { slug: string } | null)?.slug ?? "other";
    if (EXCLUDE.includes(category)) continue;
    if (ONLY.length > 0 && !ONLY.includes(category)) continue;
    const existing = (t.txn_enrichment as unknown as { note_hash: string } | null) ?? null;
    if (existing && existing.note_hash === noteHash(note)) continue;
    rows.push({
      id: t.id,
      user_id: t.user_id,
      notes: note,
      merchant: t.merchant,
      amount: Number(t.amount),
      category,
    });
  }

  if (!SPREAD) return rows.slice(0, LIMIT);

  // Round-robin across categories so a calibration run sees breadth, not
  // 30 rows of whatever category dominates recent history.
  const byCat = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byCat.get(r.category) ?? [];
    list.push(r);
    byCat.set(r.category, list);
  }
  const cats = [...byCat.keys()].sort((a, b) => byCat.get(b)!.length - byCat.get(a)!.length);
  const picked: Row[] = [];
  for (let round = 0; picked.length < LIMIT; round++) {
    let addedAny = false;
    for (const c of cats) {
      const list = byCat.get(c)!;
      if (round < list.length && picked.length < LIMIT) {
        picked.push(list[round]);
        addedAny = true;
      }
    }
    if (!addedAny) break;
  }
  return picked;
}

async function main() {
  const pending = await selectPending();
  console.log(`Selected ${pending.length} txns (limit ${LIMIT}, model ${MODEL}, batch ${BATCH_SIZE})`);
  const perCat = new Map<string, number>();
  for (const r of pending) perCat.set(r.category, (perCat.get(r.category) ?? 0) + 1);
  console.log("By category:", Object.fromEntries(perCat));

  if (DRY_RUN) {
    for (const r of pending) {
      console.log(`  [${r.category}] ${r.merchant ?? "-"} ₹${r.amount} — "${r.notes}"`);
    }
    return;
  }

  const { data: catRows, error: catErr } = await supabase.from("categories").select("slug");
  if (catErr) throw new Error(`categories load failed: ${catErr.message}`);
  const allSlugs = [...new Set((catRows ?? []).map((c) => c.slug as string))];

  let spent = 0;
  let done = 0;
  const totals = { input: 0, output: 0, reasoning: 0 };

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    if (spent >= MAX_RUPEES) {
      console.warn(`Spend ceiling ₹${MAX_RUPEES} reached after ${done} txns — stopping.`);
      break;
    }
    const batch = pending.slice(i, i + BATCH_SIZE);
    const batchCats = [...new Set(batch.map((b) => b.category))];
    const vocab = await loadVocabulary(batchCats);

    const inputs: EnrichInput[] = batch.map((b) => ({
      id: b.id,
      note: b.notes,
      merchant: b.merchant,
      amount: b.amount,
      current_category: b.category,
    }));

    const res = await enrichTransactions(inputs, allSlugs, vocab, MODEL);
    const batchCost = costRupees(MODEL, res);
    spent += batchCost;
    totals.input += res.input;
    totals.output += res.output;
    totals.reasoning += res.reasoning;

    const byId = new Map(batch.map((b) => [b.id, b]));
    const rows = res.results
      .filter((r) => byId.has(r.id))
      .map((r) => ({
        transaction_id: r.id,
        user_id: byId.get(r.id)!.user_id,
        item_label: r.item_label,
        lending: r.lending,
        category_suggestion: r.category_suggestion,
        note_hash: noteHash(byId.get(r.id)!.notes),
        model: MODEL,
        enriched_at: new Date().toISOString(),
      }));

    if (!NO_PERSIST) {
      const { error } = await supabase.from("txn_enrichment").upsert(rows);
      if (error) throw new Error(`upsert failed (batch ${i / BATCH_SIZE + 1}): ${error.message}`);
    }
    done += rows.length;

    console.log(
      `Batch ${i / BATCH_SIZE + 1}: ${rows.length}/${batch.length} enriched | ` +
        `tokens in=${res.input} out=${res.output} think=${res.reasoning} | ` +
        `₹${batchCost.toFixed(3)} (total ₹${spent.toFixed(3)})${NO_PERSIST ? " [not persisted]" : ""}`,
    );
    for (const r of res.results) {
      const src = byId.get(r.id);
      if (!src) continue;
      console.log(
        `  [${src.category}] "${src.notes}" → ${r.item_label}` +
          (r.lending ? ` | lending: ${r.lending.type} ${r.lending.counterparty}` : "") +
          (r.category_suggestion ? ` | suggest: ${r.category_suggestion}` : ""),
      );
    }
  }

  console.log(
    `\nDone: ${done} txns | tokens in=${totals.input} out=${totals.output} think=${totals.reasoning} | ₹${spent.toFixed(3)}`,
  );
  if (totals.output > 0) {
    console.log(`Think/visible ratio: ${(totals.reasoning / totals.output).toFixed(2)}x`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
