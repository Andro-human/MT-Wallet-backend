import type { TransactionInsert } from "../schemas/transaction.js";

/** Cross-channel (phone ↔ email) soft-match window. */
export const CROSS_CHANNEL_WINDOW_MS = 30 * 60 * 1000;

const PHONE_SOURCES = new Set(["sms", "ios_shortcut"]);
const EMAIL_SOURCES = new Set(["email"]);

export type IngestChannel = "phone" | "email" | "other";

export function normalizeBankName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function getIngestChannel(source: string): IngestChannel {
  if (PHONE_SOURCES.has(source)) return "phone";
  if (EMAIL_SOURCES.has(source)) return "email";
  return "other";
}

export function isAutomatedIngestSource(source: string): boolean {
  return getIngestChannel(source) !== "other";
}

export type CrossChannelCandidate = Pick<
  TransactionInsert,
  "amount" | "direction" | "account_last4" | "bank_name" | "transacted_at" | "source"
>;

export type ExistingTransactionRow = {
  id: string;
  amount: number;
  direction: string;
  account_last4: string | null;
  bank_name: string | null;
  source: string;
  transacted_at: string;
};

function withinCrossChannelWindow(a: string, b: string): boolean {
  const diff = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return diff <= CROSS_CHANNEL_WINDOW_MS;
}

/**
 * Layer 2a: phone ↔ email soft fingerprint. Requires amount, direction,
 * account_last4, and bank_name on both sides; channels must differ.
 */
export function matchesCrossChannelFingerprint(
  candidate: CrossChannelCandidate,
  existing: CrossChannelCandidate & { id?: string },
): boolean {
  if (!isAutomatedIngestSource(candidate.source)) return false;
  if (!isAutomatedIngestSource(existing.source)) return false;

  const candidateChannel = getIngestChannel(candidate.source);
  const existingChannel = getIngestChannel(existing.source);
  if (candidateChannel === "other" || existingChannel === "other") return false;
  if (candidateChannel === existingChannel) return false;

  if (!candidate.account_last4 || !existing.account_last4) return false;

  const candidateBank = normalizeBankName(candidate.bank_name);
  const existingBank = normalizeBankName(existing.bank_name);
  if (!candidateBank || !existingBank || candidateBank !== existingBank) return false;

  if (candidate.amount !== existing.amount) return false;
  if (candidate.direction !== existing.direction) return false;
  if (candidate.account_last4 !== existing.account_last4) return false;

  return withinCrossChannelWindow(candidate.transacted_at, existing.transacted_at);
}

export function findInBatchCrossChannelDuplicate(
  candidate: CrossChannelCandidate,
  batch: CrossChannelCandidate[],
): CrossChannelCandidate | null {
  for (const existing of batch) {
    if (matchesCrossChannelFingerprint(candidate, existing)) {
      return existing;
    }
  }
  return null;
}

export function findInBatchReferenceIdDuplicate(
  referenceId: string | null | undefined,
  direction: "credit" | "debit",
  batch: { reference_id: string | null; direction: string }[],
): boolean {
  if (!referenceId) return false;
  return batch.some((t) => t.reference_id === referenceId && t.direction === direction);
}

export function matchesExistingCrossChannelRow(
  candidate: CrossChannelCandidate,
  row: ExistingTransactionRow,
): boolean {
  return matchesCrossChannelFingerprint(candidate, {
    amount: Number(row.amount),
    direction: row.direction as CrossChannelCandidate["direction"],
    account_last4: row.account_last4,
    bank_name: row.bank_name,
    transacted_at: row.transacted_at,
    source: row.source as CrossChannelCandidate["source"],
  });
}
