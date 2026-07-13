import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { generateObject } from "ai";
import { z } from "zod";

const ENRICH_MODEL = "gemini-2.5-flash";

function resolveModel(id: string) {
  return id.includes("/") ? groq(id) : google(id);
}

export interface EnrichInput {
  id: string;
  note: string;
  merchant: string | null;
  amount: number;
  current_category: string;
}

export const EnrichmentResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().describe("Echo the input id exactly."),
      item_label: z
        .string()
        .describe(
          "Short canonical kebab-case label for WHAT this spend was, within its category. Collapse synonyms to ONE label (e.g. 'sheba cat food' and '#Online | cat food' → 'cat-food'; 'RCT' and 'tooth filling' → 'dental')."
        ),
      lending: z
        .object({
          counterparty: z.string(),
          type: z.enum(["lent", "repayment"]),
        })
        .nullable()
        .describe("Set only if the note says money was lent to / borrowed from a named person. Else null."),
      category_suggestion: z
        .string()
        .nullable()
        .describe("If the note clearly does NOT match current_category, the better category slug from the allowed list. Else null."),
    })
  ),
});

export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>["results"][number];

export function buildEnrichmentPrompt(
  categorySlugs: string[],
  vocabularyByCategory: Record<string, string[]>
): string {
  const vocabLines = Object.entries(vocabularyByCategory)
    .filter(([, labels]) => labels.length > 0)
    .map(([cat, labels]) => `  ${cat}: ${labels.join(", ")}`)
    .join("\n");

  return `You label personal-finance transactions. The user writes a free-text note on each spend.
For each input you get: id, note, merchant, amount, current_category.

Return for each:
- item_label: a short canonical kebab-case label for the MEANINGFUL SPENDING THEME, scoped to its category — not the individual product.
  Rules:
  * Merge every variant of the same activity into ONE label: all vet / grooming / checkup / deworming → "vet"; all dental procedures / dental visits / dental medicine → "dental"; leashes, collars, combs, bowls, fountains → "accessories".
  * A label used by a single transaction is a smell — only keep it if it's a real theme, not a sub-type of an existing one (never both "vet" and "vet-visit").
  * For a note listing multiple items, use the dominant one.
  * Aim for a handful of themes per category, meaningful enough to be worth a sub-line. Too granular defeats the purpose.
- lending: {counterparty, type:'lent'|'repayment'} only if the note indicates money lent to / borrowed from a named person; else null.
- category_suggestion: if the note clearly contradicts current_category, the better slug from [${categorySlugs.join(", ")}]; else null. Be conservative — only flag clear mismatches.

Existing labels already in use (REUSE these when they fit; invent new only when none fit):
${vocabLines || "  (none yet)"}

Return one result per input, in the same order, echoing id exactly.`;
}

export async function enrichTransactions(
  inputs: EnrichInput[],
  categorySlugs: string[],
  vocabularyByCategory: Record<string, string[]> = {},
  model: string = ENRICH_MODEL
): Promise<{ results: EnrichmentResult[]; input: number; output: number; reasoning: number }> {
  if (inputs.length === 0) return { results: [], input: 0, output: 0, reasoning: 0 };

  const system = buildEnrichmentPrompt(categorySlugs, vocabularyByCategory);
  const prompt = `INPUT:\n\`\`\`json\n${JSON.stringify(inputs)}\n\`\`\``;

  const res = await generateObject({
    model: resolveModel(model),
    system,
    prompt,
    schema: EnrichmentResultSchema,
    temperature: 0,
    maxRetries: 0, // never retry against a spend cap / 429 — one attempt, fail fast
  });

  return {
    results: res.object.results,
    input: res.usage?.inputTokens ?? 0,
    output: res.usage?.outputTokens ?? 0,
    reasoning: res.usage?.reasoningTokens ?? 0,
  };
}
