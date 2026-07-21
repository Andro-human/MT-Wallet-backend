import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";
import { supabase } from "./supabase.js";

const SUMMARY_MODEL = "gemini-2.5-flash";

/**
 * Layer D: the frontend computes every number (transactionMath owns refunds,
 * dupes, group exclusion) and sends them here; the model only turns them into
 * words. It must never do arithmetic of its own.
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

const SummaryResultSchema = z.object({
  summary: z
    .string()
    .describe("2-4 sentences: where the month's money went, plain and concrete."),
  highlights: z
    .array(z.string())
    .min(2)
    .max(5)
    .describe("Short punchy bullets, each grounded in a provided number."),
});

const SYSTEM_PROMPT = `You write a short monthly money recap for a personal finance app user in India.

Rules:
- Use ONLY the numbers provided. Never add, subtract, average, or invent numbers.
- Format amounts compactly in INR (₹12,400 or ₹1.2k style is fine).
- Be concrete and specific — name the biggest categories/groups and sub-themes.
- Plain, friendly, direct. No financial advice, no moralizing, no "consider budgeting".
- If recurring_monthly_committed is present, mention it as the fixed monthly commitment.
- If loans_outstanding is present and > 0, mention money currently lent out.`;

export async function generateMonthlySummary(
  userId: string,
  aggregates: MonthlyAggregates,
): Promise<{ summary: string; highlights: string[]; model: string; usage: Record<string, number> }> {
  const res = await generateObject({
    model: google(SUMMARY_MODEL),
    schema: SummaryResultSchema,
    system: SYSTEM_PROMPT,
    prompt: `MONTH DATA:\n\`\`\`json\n${JSON.stringify(aggregates)}\n\`\`\``,
    temperature: 0.4,
    maxRetries: 0,
  });

  const usage = {
    input: res.usage?.inputTokens ?? 0,
    output: res.usage?.outputTokens ?? 0,
    reasoning: res.usage?.reasoningTokens ?? 0,
  };

  const { error } = await supabase.from("monthly_summaries").upsert({
    user_id: userId,
    month: aggregates.month,
    summary: res.object.summary,
    highlights: res.object.highlights,
    aggregates,
    usage,
    model: SUMMARY_MODEL,
    generated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`summary upsert failed: ${error.message}`);

  return { summary: res.object.summary, highlights: res.object.highlights, model: SUMMARY_MODEL, usage };
}
