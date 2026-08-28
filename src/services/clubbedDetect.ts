/** Spotting a charge that bundled a subscription in with other shopping.
 *
 *  Port of MT-Wallet/src/lib/clubbedDetect.ts. The frontend needs it to mark
 *  rows as you look at them; the nightly pass needs it to fix them while you are
 *  asleep. Keep the two in step: a rule that fires here but not there marks a row
 *  the app then silently disagrees with.
 */

const SEPARATORS = /\s*(?:\+|&|,|\/|\band\b|\bwith\b)\s*/i;
const LEADING_TAG = /^\s*#\S+\s*\|\s*/;
const QUANTITY = /^\s*\d+\s*x\s*/i;

export const AMOUNT_MULTIPLE = 2.5;

export function splitNoteItems(note: string | null | undefined): string[] {
  const cleaned = (note ?? "").replace(LEADING_TAG, "").trim();
  if (!cleaned) return [];
  return cleaned
    .split(SEPARATORS)
    .map((part) => part.replace(QUANTITY, "").trim())
    .filter(Boolean);
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function noteNamesOtherItems(
  note: string | null | undefined,
  matchTerm: string | null | undefined,
): boolean {
  const term = (matchTerm ?? "").trim().toLowerCase();
  if (!term) return false;
  const items = splitNoteItems(note);
  if (items.length < 2) return false;
  return items.some((item) => !item.toLowerCase().includes(term));
}

export interface Occurrence {
  transactionId: string;
  note: string | null;
  txnAmount: number;
  /** What is attributed today. */
  attributed: number;
  /** null when nobody has decided; 'manual' is the user's own call. */
  attributionSetBy: string | null;
}

export interface Proposal {
  transactionId: string;
  from: number;
  to: number;
  reason: "note" | "amount" | "both";
}

const EPSILON = 0.005;

/** What the nightly pass should change, and nothing more.
 *
 *  Three conditions before a row is touched, all of them about not overruling a
 *  human:
 *   - it looks bundled
 *   - the whole charge is still attributed, so nobody has apportioned it
 *   - attribution_set_by is null, so nobody has deliberately chosen the full
 *     amount either. A user who says "count all of it" leaves a full attribution
 *     that is indistinguishable from an untouched one without this flag.
 */
export function proposeAttributions(
  occurrences: Occurrence[],
  matchTerm: string | null | undefined,
): { proposals: Proposal[]; typical: number | null } {
  // Without a match term no note can be judged, so every row counts as clean and
  // the median is computed from a set that still contains the bundles. That
  // estimate is polluted by the very rows it would be used to correct, which is
  // not something to write to anyone's data unattended.
  if (!(matchTerm ?? "").trim()) return { proposals: [], typical: null };

  const byNote = new Map<string, boolean>();
  for (const o of occurrences) {
    byNote.set(o.transactionId, noteNamesOtherItems(o.note, matchTerm));
  }

  const cleanAmounts = occurrences
    .filter((o) => !byNote.get(o.transactionId))
    .map((o) => o.txnAmount)
    .sort((a, b) => a - b);
  const typical = median(cleanAmounts);

  if (typical === null || cleanAmounts.length < 2) return { proposals: [], typical };

  const proposals: Proposal[] = [];
  for (const o of occurrences) {
    if (o.attributionSetBy !== null) continue;
    if (o.attributed < o.txnAmount - EPSILON) continue;

    const byNoteHit = byNote.get(o.transactionId) === true;
    const byAmountHit = o.txnAmount > typical * AMOUNT_MULTIPLE;
    if (!byNoteHit && !byAmountHit) continue;

    // Nothing to gain from "correcting" a charge to more than it was, or to the
    // same figure it already carries.
    if (typical >= o.txnAmount - EPSILON) continue;

    proposals.push({
      transactionId: o.transactionId,
      from: o.txnAmount,
      to: typical,
      reason: byNoteHit && byAmountHit ? "both" : byNoteHit ? "note" : "amount",
    });
  }

  return { proposals, typical };
}
