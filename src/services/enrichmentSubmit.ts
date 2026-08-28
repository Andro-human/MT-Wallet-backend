import { z } from "zod";

/** Pure validation for agent-submitted enrichment.
 *
 *  The Gemini pass had no gate: whatever the model returned went into the
 *  table. This path is the same shape as the review pipeline instead, where the
 *  agent proposes labels and the server refuses anything it cannot verify.
 *
 *  Nothing here is a number, so there is no arithmetic to reconcile. What can
 *  be checked is that every id was actually offered, every category slug
 *  exists, and no field is a shape the client cannot read back.
 */

export const EnrichmentItemSchema = z.object({
  id: z.string().uuid(),
  lending: z
    .object({
      counterparty: z.string().trim().min(1).max(80),
      type: z.enum(["lent", "repayment"]),
    })
    .nullable()
    .optional(),
  category_suggestion: z.string().trim().min(1).max(64).nullable().optional(),
  service_identity: z.string().trim().min(1).max(80).nullable().optional(),
});

export const EnrichmentSubmissionSchema = z.object({
  model: z.string().trim().min(1).max(80),
  items: z.array(EnrichmentItemSchema).max(2000),
});

export type EnrichmentItem = z.infer<typeof EnrichmentItemSchema>;
export type EnrichmentSubmission = z.infer<typeof EnrichmentSubmissionSchema>;

export interface EnrichmentVerdict {
  accepted: EnrichmentItem[];
  errors: string[];
}

const MAX_ERRORS = 40;

/** Reject what cannot be trusted, keep the rest.
 *
 *  Deliberately partial rather than all-or-nothing, unlike the monthly review.
 *  A review is one artefact whose parts must reconcile with each other; these
 *  are independent per-transaction labels, so dropping one bad category
 *  suggestion should not throw away forty good ones.
 */
export function verifyEnrichment(
  submission: EnrichmentSubmission,
  offeredIds: Set<string>,
  knownCategorySlugs: Set<string>,
): EnrichmentVerdict {
  const accepted: EnrichmentItem[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  const note = (msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(msg);
  };

  for (const item of submission.items) {
    // Only rows the server offered. Otherwise a stale run could relabel
    // transactions nobody asked about, including ones edited since.
    if (!offeredIds.has(item.id)) {
      note(`${item.id}: not in the pending set`);
      continue;
    }
    if (seen.has(item.id)) {
      note(`${item.id}: submitted twice`);
      continue;
    }
    seen.add(item.id);

    // A suggestion naming a category that does not exist is unactionable: the
    // Apply button would have nothing to apply.
    if (
      item.category_suggestion != null &&
      !knownCategorySlugs.has(item.category_suggestion.toLowerCase())
    ) {
      note(`${item.id}: unknown category slug "${item.category_suggestion}"`);
      continue;
    }

    accepted.push({
      id: item.id,
      lending: item.lending ?? null,
      category_suggestion: item.category_suggestion ?? null,
      service_identity: item.service_identity ?? null,
    });
  }

  return { accepted, errors };
}
