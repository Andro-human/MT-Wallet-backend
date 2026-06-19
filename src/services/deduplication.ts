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

// Prefix-match so "SBI" and "SBI Card" read as one issuer; substring would be too loose.
export function bankNamesCompatible(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export type BankAlias = {
  source_bank_name: string | null;
  source_account_last4: string | null;
  target_bank_name: string | null;
  target_account_last4: string | null;
};

export type ResolvedAccount = { bank: string | null; last4: string | null };
export type AliasResolver = (bank: string | null, last4: string | null) => ResolvedAccount;

const IDENTITY_RESOLVER: AliasResolver = (bank, last4) => ({ bank, last4 });

function aliasKey(bank: string | null, last4: string | null): string {
  return `${normalizeBankName(bank) ?? ""}|${(last4 ?? "").trim()}`;
}

/** Build a resolver that canonicalizes (bank, last4) via the user's aliases. */
export function buildAliasResolver(aliases: BankAlias[]): AliasResolver {
  const map = new Map<string, ResolvedAccount>();
  for (const a of aliases) {
    map.set(aliasKey(a.source_bank_name, a.source_account_last4), {
      bank: a.target_bank_name,
      last4: a.target_account_last4,
    });
  }
  return (bank, last4) => map.get(aliasKey(bank, last4)) ?? { bank, last4 };
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
  "amount" | "direction" | "account_last4" | "bank_name" | "transacted_at" | "source" | "reference_id"
>;

export type ExistingTransactionRow = {
  id: string;
  amount: number;
  direction: string;
  account_last4: string | null;
  bank_name: string | null;
  source: string;
  transacted_at: string;
  reference_id: string | null;
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
  resolve: AliasResolver = IDENTITY_RESOLVER,
): boolean {
  if (!isAutomatedIngestSource(candidate.source)) return false;
  if (!isAutomatedIngestSource(existing.source)) return false;

  const candidateChannel = getIngestChannel(candidate.source);
  const existingChannel = getIngestChannel(existing.source);
  if (candidateChannel === "other" || existingChannel === "other") return false;
  if (candidateChannel === existingChannel) return false;

  // Differing references = distinct payments; never fuzzy-merge them. Same/absent ref falls through.
  const candRef = candidate.reference_id?.trim();
  const existRef = existing.reference_id?.trim();
  if (candRef && existRef && candRef !== existRef) return false;

  // Canonicalize via aliases so "SBI Card"/"SBI" (and remapped last4) compare equal.
  const c = resolve(candidate.bank_name ?? null, candidate.account_last4 ?? null);
  const e = resolve(existing.bank_name ?? null, existing.account_last4 ?? null);

  if (!c.last4 || !e.last4) return false;
  if (c.last4 !== e.last4) return false;

  const candidateBank = normalizeBankName(c.bank);
  const existingBank = normalizeBankName(e.bank);
  if (!candidateBank || !existingBank || !bankNamesCompatible(candidateBank, existingBank)) return false;

  if (candidate.amount !== existing.amount) return false;
  if (candidate.direction !== existing.direction) return false;

  return withinCrossChannelWindow(candidate.transacted_at, existing.transacted_at);
}

export function findInBatchCrossChannelDuplicate(
  candidate: CrossChannelCandidate,
  batch: CrossChannelCandidate[],
  resolve: AliasResolver = IDENTITY_RESOLVER,
): CrossChannelCandidate | null {
  for (const existing of batch) {
    if (matchesCrossChannelFingerprint(candidate, existing, resolve)) {
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
  resolve: AliasResolver = IDENTITY_RESOLVER,
): boolean {
  return matchesCrossChannelFingerprint(candidate, {
    amount: Number(row.amount),
    direction: row.direction as CrossChannelCandidate["direction"],
    account_last4: row.account_last4,
    bank_name: row.bank_name,
    transacted_at: row.transacted_at,
    source: row.source as CrossChannelCandidate["source"],
    reference_id: row.reference_id,
  }, resolve);
}
