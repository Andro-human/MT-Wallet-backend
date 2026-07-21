import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";
import { supabase } from "./supabase.js";
import { costRupees } from "./enrichmentJob.js";

// flash-lite: grouping is a light task and flash-lite emits no thinking tokens,
// so it lands ~10x cheaper than flash (measured ₹0.16 vs ₹1.53 on a 130-txn month)
// with grouping quality that holds up. The reconciliation guard below catches the
// rare category it can't cleanly partition.
const SUMMARY_MODEL = "gemini-2.5-flash-lite";

/**
 * Layer D: the frontend computes every number (transactionMath owns refunds,
 * dupes, group exclusion) and sends them here; the model only turns them into
 * words and groups transactions by meaning. It must never do arithmetic.
 */
export const MonthlyAggregatesSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  total_spent: z.number(),
  total_income: z.number(),
  allocations: z
    .array(z.object({ name: z.string(), amount: z.number(), type: z.enum(["group", "category"]) }))
    .max(12),
  top_sub_themes: z
    .array(z.object({ context: z.string(), label: z.string(), amount: z.number() }))
    .max(10)
    .default([]),
  recurring_monthly_committed: z.number().nullable().default(null),
  loans_outstanding: z.number().nullable().default(null),
});
export type MonthlyAggregates = z.infer<typeof MonthlyAggregatesSchema>;

// Per-category transactions the client sends for grouping. Amounts are already
// refund-netted / deduped by transactionMath; ordinals (`n`) are unique across
// the whole month so a group can't ambiguously reference another category.
export const MonthlyCategoryInputSchema = z
  .array(
    z.object({
      category: z.string(),
      name: z.string(),
      total: z.number(),
      items: z.array(
        z.object({
          n: z.number().int(),
          merchant: z.string().nullable(),
          note: z.string().nullable(),
          amount: z.number(),
        }),
      ),
    }),
  )
  .default([]);
export type MonthlyCategoryInput = z.infer<typeof MonthlyCategoryInputSchema>;

// A code-computed breakdown per category. `groups` amounts are summed in code
// from the referenced ordinals — never returned by the model. `reconciled=false`
// means the model's grouping failed the guard and the UI shows the flat total.
export interface CategoryGroup {
  label: string;
  amount: number;
  count: number;
}
export interface CategoryBreakdown {
  category: string;
  name: string;
  total: number;
  one_liner: string | null;
  groups: CategoryGroup[];
  reconciled: boolean;
}

const AiGroupSchema = z.object({
  label: z.string().describe("Short human label for what this cluster of spend was FOR (e.g. 'Health insurance', 'Swiggy dinners'). No amounts, no rupee figures."),
  ordinals: z.array(z.number().int()).min(1).describe("The item numbers (n) from this category that belong to this cluster."),
});
const AiCategorySchema = z.object({
  category: z.string().describe("The category slug, copied EXACTLY from input."),
  one_liner: z.string().describe("One short sentence naming what drove this category. No advice."),
  groups: z.array(AiGroupSchema).describe("Every item in this category assigned to exactly one group, ordered biggest-spend first. Un-noted items may form one coarse group."),
});
const InsightsResultSchema = z.object({
  summary: z
    .string()
    .describe("2-3 DENSE sentences: where the month's money actually went, biggest to smallest, named specifically. Use ONLY provided numbers. No advice, no filler, no greeting."),
  highlights: z
    .array(z.string())
    .min(2)
    .max(6)
    .describe("Punchy grouped bullets, biggest first, each naming a concrete theme grounded in a provided number. No moralizing."),
  categories: z.array(AiCategorySchema).default([]),
});

const SYSTEM_PROMPT = `You are the insight layer of a personal-finance app in India.

Two jobs:
1) Write a DENSE monthly recap — where the money went, biggest to smallest, named concretely. More signal, less prose. No advice, no "consider budgeting", no greeting or sign-off.
2) For each category, group its transactions by what the money was actually FOR, using the note first, then the merchant. Give each group a short human label. Every item lands in exactly ONE group. Un-noted items may form one coarse group (e.g. "Other / un-noted"). Order groups biggest-spend first.

Rules:
- Use ONLY the numbers provided. NEVER add, subtract, average, or invent a number. Amounts in your prose must be numbers that appear in the input.
- Copy category slugs and item numbers (n) EXACTLY.
- Format amounts compactly in INR when you mention them (₹12,400 / ₹1.2k).`;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reconcile the model's per-category groupings against the real transactions.
 * Code owns every rupee: group amounts are summed here from the referenced
 * ordinals. A category is accepted only if every one of its items is covered
 * exactly once, no foreign/duplicate ordinals slipped in, and the group sums
 * match the category total. Otherwise it degrades to a flat total (no groups).
 */
export function reconcileBreakdowns(
  input: MonthlyCategoryInput,
  aiCategories: z.infer<typeof AiCategorySchema>[],
): { breakdowns: CategoryBreakdown[]; reconciled: number; rejected: number } {
  const aiBySlug = new Map(aiCategories.map((c) => [c.category, c]));
  const breakdowns: CategoryBreakdown[] = [];
  let reconciled = 0;
  let rejected = 0;

  for (const cat of input) {
    const amountByN = new Map(cat.items.map((it) => [it.n, it.amount]));
    const realOrds = new Set(cat.items.map((it) => it.n));
    const ai = aiBySlug.get(cat.category);

    const fallback = (): CategoryBreakdown => {
      rejected++;
      return { category: cat.category, name: cat.name, total: round2(cat.total), one_liner: null, groups: [], reconciled: false };
    };

    if (!ai || ai.groups.length === 0) {
      breakdowns.push(fallback());
      continue;
    }

    const seen = new Set<number>();
    let foreign = false;
    let dup = false;
    const groups: CategoryGroup[] = [];
    for (const g of ai.groups) {
      let sum = 0;
      let count = 0;
      for (const o of g.ordinals) {
        if (!realOrds.has(o)) { foreign = true; continue; }
        if (seen.has(o)) { dup = true; continue; }
        seen.add(o);
        sum += amountByN.get(o)!;
        count++;
      }
      if (count > 0) groups.push({ label: g.label, amount: round2(sum), count });
    }

    const covered = seen.size === realOrds.size;
    const groupSum = groups.reduce((s, g) => s + g.amount, 0);
    const sumMatches = Math.abs(groupSum - cat.total) < 0.01;

    if (!covered || foreign || dup || !sumMatches) {
      breakdowns.push(fallback());
      continue;
    }

    reconciled++;
    breakdowns.push({
      category: cat.category,
      name: cat.name,
      total: round2(cat.total),
      one_liner: ai.one_liner ?? null,
      groups: groups.sort((a, b) => b.amount - a.amount),
      reconciled: true,
    });
  }

  return { breakdowns, reconciled, rejected };
}

export async function generateMonthlySummary(
  userId: string,
  aggregates: MonthlyAggregates,
  categoryInput: MonthlyCategoryInput = [],
): Promise<{
  summary: string;
  highlights: string[];
  category_breakdowns: CategoryBreakdown[];
  model: string;
  usage: Record<string, number>;
}> {
  const promptPayload = {
    aggregates,
    categories: categoryInput.map((c) => ({
      category: c.category,
      category_name: c.name,
      total: Math.round(c.total),
      items: c.items.map((it) => ({ n: it.n, merchant: it.merchant, note: it.note, amount: Math.round(it.amount) })),
    })),
  };

  const res = await generateObject({
    model: google(SUMMARY_MODEL),
    schema: InsightsResultSchema,
    system: SYSTEM_PROMPT,
    prompt: `DATA:\n\`\`\`json\n${JSON.stringify(promptPayload)}\n\`\`\``,
    temperature: 0.3,
    maxRetries: 0,
  });

  const usage = {
    input: res.usage?.inputTokens ?? 0,
    output: res.usage?.outputTokens ?? 0,
    reasoning: res.usage?.reasoningTokens ?? 0,
  };

  const { breakdowns, reconciled, rejected } = reconcileBreakdowns(categoryInput, res.object.categories);
  console.log(
    `[insights] ${aggregates.month} on ${SUMMARY_MODEL}: ${reconciled} categories grouped, ${rejected}→flat; ` +
      `tokens in=${usage.input} out=${usage.output} think=${usage.reasoning}, ₹${costRupees(SUMMARY_MODEL, usage).toFixed(3)}`,
  );

  const { error } = await supabase.from("monthly_summaries").upsert({
    user_id: userId,
    month: aggregates.month,
    summary: res.object.summary,
    highlights: res.object.highlights,
    aggregates,
    category_breakdowns: breakdowns,
    usage,
    model: SUMMARY_MODEL,
    generated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`summary upsert failed: ${error.message}`);

  return {
    summary: res.object.summary,
    highlights: res.object.highlights,
    category_breakdowns: breakdowns,
    model: SUMMARY_MODEL,
    usage,
  };
}
