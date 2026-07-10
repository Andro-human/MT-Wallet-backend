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

const MERCHANT_SUFFIXES =
  /\b(private limited|pvt\.? ltd\.?|private ltd|limited|ltd|pvt|inc|llc)\b/g;

export function normalizeMerchant(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(MERCHANT_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 0 ? s : null;
}

function normalizeSender(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  return t.length > 0 ? t : null;
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
> & {
  merchant: string | null;
  sms_sender: string | null;
};

export type ExistingTransactionRow = {
  id: string;
  amount: number;
  direction: string;
  account_last4: string | null;
  bank_name: string | null;
  source: string;
  transacted_at: string;
  reference_id: string | null;
  merchant: string | null;
  sms_sender: string | null;
};

function withinCrossChannelWindow(a: string, b: string): boolean {
  const diff = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return diff <= CROSS_CHANNEL_WINDOW_MS;
}

// A single notifier (a bank SMS short-code, a Razorpay/Amazon Pay/Google email
// address) reports any one payment exactly once. So two rows from the SAME notifier
// are two real payments; two rows from DIFFERENT notifiers are one payment seen twice.
// sms_sender is that notifier identity. When it's absent we fall back to the coarser
// channel (phone vs email).
function sameNotifier(a: CrossChannelCandidate, b: CrossChannelCandidate): boolean {
  const sa = normalizeSender(a.sms_sender);
  const sb = normalizeSender(b.sms_sender);
  if (sa && sb) return sa === sb;
  return getIngestChannel(a.source) === getIngestChannel(b.source);
}

/**
 * Strong-tier auto-merge fingerprint. Two automated-ingest rows are the same payment
 * when amount + direction match within the window, they come from DIFFERENT notifiers,
 * and one strong corroborator holds: the same card (last4), or the same merchant on a
 * compatible bank. Bank name and reference are deliberately NOT required to agree —
 * different notifiers report different banks (HSBC vs Razorpay) and different reference
 * schemes (bank RRN vs Google order id) for the very same payment. Weaker cases
 * (merchant-only, banks differ) are left for the in-app duplicate banner to confirm.
 */
export function matchesCrossChannelFingerprint(
  candidate: CrossChannelCandidate,
  existing: CrossChannelCandidate & { id?: string },
  resolve: AliasResolver = IDENTITY_RESOLVER,
): boolean {
  if (!isAutomatedIngestSource(candidate.source)) return false;
  if (!isAutomatedIngestSource(existing.source)) return false;

  if (candidate.amount !== existing.amount) return false;
  if (candidate.direction !== existing.direction) return false;
  if (!withinCrossChannelWindow(candidate.transacted_at, existing.transacted_at)) return false;

  if (sameNotifier(candidate, existing)) return false;

  // Canonicalize via aliases so "SBI Card"/"SBI" (and remapped last4) compare equal.
  const c = resolve(candidate.bank_name ?? null, candidate.account_last4 ?? null);
  const e = resolve(existing.bank_name ?? null, existing.account_last4 ?? null);

  if (c.last4 && e.last4 && c.last4 === e.last4) return true;

  const candidateMerchant = normalizeMerchant(candidate.merchant ?? null);
  const existingMerchant = normalizeMerchant(existing.merchant ?? null);
  const candidateBank = normalizeBankName(c.bank);
  const existingBank = normalizeBankName(e.bank);
  if (
    candidateMerchant &&
    existingMerchant &&
    candidateMerchant === existingMerchant &&
    candidateBank &&
    existingBank &&
    bankNamesCompatible(candidateBank, existingBank)
  ) {
    return true;
  }

  return false;
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
    merchant: row.merchant,
    sms_sender: row.sms_sender,
  }, resolve);
}
