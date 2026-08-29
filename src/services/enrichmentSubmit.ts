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
  /** The subscription this charge belongs to, chosen from the list the payload
   *  carried. Replaces the round trip where the agent wrote a service name as
   *  free text and the server tried to string-match it back to a subscription:
   *  "policy bazzar" only ever reached Life Insurance by luck. */
  subscription_id: z.string().uuid().nullable().optional(),
});

export const EnrichmentSubmissionSchema = z.object({
  model: z.string().trim().min(1).max(80),
  // Echo of the cutoff the agent fetched with. Submit has to rebuild the same
  // offered set from scratch; without the echo, every item of a backfill run
  // comes back rejected as never-offered.
  relabel_before: z
    .string()
    .refine((s) => Number.isFinite(Date.parse(s)), "not a parsable date")
    .optional(),
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
  opts: {
    /** Ids the payload marked as eligible for a category suggestion. A row
     *  re-offered only to backfill a field is not one of them. */
    suggestableIds?: Set<string>;
    knownSubscriptionIds?: Set<string>;
  } = {},
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

    // Dropped rather than rejected: the row's other fields are still wanted,
    // and a backfill run has no business reopening a settled category.
    let suggestion = item.category_suggestion ?? null;
    if (suggestion != null && opts.suggestableIds && !opts.suggestableIds.has(item.id)) {
      note(`${item.id}: category suggestion ignored, this row was offered only for backfill`);
      suggestion = null;
    }

    if (
      item.subscription_id != null &&
      opts.knownSubscriptionIds &&
      !opts.knownSubscriptionIds.has(item.subscription_id)
    ) {
      note(`${item.id}: unknown subscription "${item.subscription_id}"`);
      continue;
    }

    accepted.push({
      id: item.id,
      lending: item.lending ?? null,
      category_suggestion: suggestion,
      service_identity: item.service_identity ?? null,
      subscription_id: item.subscription_id ?? null,
    });
  }

  return { accepted, errors };
}
