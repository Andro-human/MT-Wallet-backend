import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import type { Category, GmailWatchState, User, ParsedTransactionResult, SMSMessage, UserMerchantMapping } from "../types/index.js";
import type { TransactionInsert } from "../schemas/transaction.js";
import {
  CROSS_CHANNEL_WINDOW_MS,
  matchesExistingCrossChannelRow,
  type CrossChannelCandidate,
  type ExistingTransactionRow,
} from "./deduplication.js";

// Create Supabase client with service role key (bypasses RLS)
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);

/**
 * Get user by API key
 */
export async function getUserByApiKey(apiKey: string): Promise<User | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, enable_review_mode")
    .eq("api_key", apiKey)
    .single();

  if (error || !data) {
    console.error("Failed to get user by API key:", error?.message);
    return null;
  }

  return {
    id: data.user_id,
    enable_review_mode: data.enable_review_mode,
  };
}

/**
 * Read the Gmail Pub/Sub ingestion state for a user.
 * Returns null if the user doesn't exist or no row matches.
 */
export async function getGmailWatchState(userId: string): Promise<GmailWatchState | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("gmail_last_history_id, gmail_watch_expires_at")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    console.error("Failed to get gmail watch state:", error?.message);
    return null;
  }

  return {
    userId,
    lastHistoryId: data.gmail_last_history_id ?? null,
    watchExpiresAt: data.gmail_watch_expires_at ? new Date(data.gmail_watch_expires_at) : null,
  };
}

/**
 * Update Gmail watch state. Pass only the fields you want to change.
 *
 * NOTE: `lastHistoryId` should ONLY advance forward. Callers (the Pub/Sub
 * webhook) are expected to pass the historyId from the latest notification
 * after they finish processing.
 */
export async function updateGmailWatchState(
  userId: string,
  patch: { lastHistoryId?: string; watchExpiresAt?: Date | null },
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.lastHistoryId !== undefined) update.gmail_last_history_id = patch.lastHistoryId;
  if (patch.watchExpiresAt !== undefined) {
    update.gmail_watch_expires_at = patch.watchExpiresAt?.toISOString() ?? null;
  }

  const { error } = await supabase
    .from("profiles")
    .update(update)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Failed to update gmail watch state: ${error.message}`);
  }
}

/**
 * Get user merchant mappings
 */
export async function getUserMerchantMappings(userId: string): Promise<UserMerchantMapping[]> {
  const { data, error } = await supabase
    .from("user_merchant_mappings")
    .select("id, user_id, raw_merchant, mapped_merchant, default_category_id, default_is_expense, default_is_income, amount_operator, amount_threshold, date_operator, date_threshold, match_type")
    .eq("user_id", userId);

  if (error) {
    console.error("Failed to get merchant mappings:", error.message);
    return [];
  }

  return data || [];
}

/**
 * Get all categories (system + user's custom)
 */
export async function getCategories(userId?: string): Promise<Category[]> {
  let query = supabase.from("categories").select("id, slug, name");

  if (userId) {
    // Get system categories + user's custom categories
    query = query.or(`is_system.eq.true,user_id.eq.${userId}`);
  } else {
    // Only system categories
    query = query.eq("is_system", true);
  }

  const { data, error } = await query.order("sort_order", { ascending: true });

  if (error) {
    console.error("Failed to get categories:", error.message);
    return [];
  }

  return data || [];
}

/**
 * Get category ID by slug (synchronous - categories already loaded)
 */
export function getCategoryIdBySlug(
  slug: string | null | undefined,
  categories: Category[]
): string | null {
  if (!slug) return null;

  const category = categories.find(
    (c) => c.slug.toLowerCase() === slug.toLowerCase()
  );

  return category?.id || null;
}

/**
 * Layer 1: find an existing row with the same bank reference id + direction.
 * Direction is part of the key because some banks reuse the same UPI Ref for
 * the original debit and its reversal (credit) — both are legitimate rows.
 */
export async function findTransactionByReferenceId(
  userId: string,
  referenceId: string,
  direction: "credit" | "debit",
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("transactions")
    .select("id")
    .eq("user_id", userId)
    .eq("reference_id", referenceId)
    .eq("direction", direction)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Failed to look up transaction by reference_id:", error.message);
    return null;
  }

  return data ? { id: data.id } : null;
}

/**
 * Layer 2a: find a phone↔email duplicate in the recent window.
 * Caller must ensure candidate has non-null account_last4 and bank_name.
 */
export async function findCrossChannelDuplicate(
  userId: string,
  candidate: CrossChannelCandidate,
): Promise<{ id: string } | null> {
  const center = new Date(candidate.transacted_at).getTime();
  const from = new Date(center - CROSS_CHANNEL_WINDOW_MS).toISOString();
  const to = new Date(center + CROSS_CHANNEL_WINDOW_MS).toISOString();

  const { data, error } = await supabase
    .from("transactions")
    .select("id, amount, direction, account_last4, bank_name, source, transacted_at")
    .eq("user_id", userId)
    .eq("amount", candidate.amount)
    .eq("direction", candidate.direction)
    .eq("account_last4", candidate.account_last4!)
    .gte("transacted_at", from)
    .lte("transacted_at", to);

  if (error) {
    console.error("Failed to look up cross-channel duplicate:", error.message);
    return null;
  }

  for (const row of (data || []) as ExistingTransactionRow[]) {
    if (matchesExistingCrossChannelRow(candidate, row)) {
      return { id: row.id };
    }
  }

  return null;
}

/**
 * Insert a transaction (upsert to handle duplicates)
 */
export async function insertTransaction(
  transaction: TransactionInsert
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.from("transactions").upsert(transaction, {
    onConflict: "user_id,sms_id",
    ignoreDuplicates: true,
  });

  if (error) {
    // Check if it's a duplicate error (expected, not a real error)
    if (error.code === "23505") {
      return { success: true }; // Already exists, count as success
    }
    console.error("Failed to insert transaction:", error.message);
    return { success: false, error: error.message };
  }

  return { success: true };
}

/**
 * Insert multiple transactions in a single bulk upsert call
 */
export async function insertTransactions(
  transactions: TransactionInsert[]
): Promise<{ inserted: number; errors: number }> {
  if (transactions.length === 0) {
    return { inserted: 0, errors: 0 };
  }

  const { error } = await supabase.from("transactions").upsert(transactions, {
    onConflict: "user_id,sms_id",
    ignoreDuplicates: true,
  });

  if (error) {
    console.error("Bulk insert failed:", error.message);
    // If the entire batch fails, report all as errors
    return { inserted: 0, errors: transactions.length };
  }

  return { inserted: transactions.length, errors: 0 };
}

/**
 * Look up a sync_run owned by the given user. Returns null if not found or not
 * owned. Used by the reclassify endpoints to verify the message exists in this
 * run + belongs to the caller before mutating anything.
 */
export async function getSyncRunForUser(
  runId: string,
  userId: string
): Promise<{
  id: string;
  user_id: string;
  messages: { id: number; sender: string; body: string; timestamp: string | null }[] | null;
} | null> {
  const { data, error } = await supabase
    .from("sync_runs")
    .select("id, user_id, messages")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Failed to fetch sync run:", error.message);
    return null;
  }
  return (data as any) ?? null;
}

/**
 * After a reclassify, patch the sync_run's `details` array (the per-message
 * snapshot stored at ingest time) so the UI's status badge / counts reflect
 * the user's correction without needing a separate "manual override" join.
 *
 * - Replaces the existing detail entry for sms_id (or appends if none).
 * - Recomputes inserted/skipped/errors from the new details array.
 */
export async function updateSyncRunDetail(params: {
  runId: string;
  userId: string;
  smsId: number;
  newDetail: ParsedTransactionResult;
}): Promise<{ success: boolean; error?: string }> {
  const { data: run, error: fetchErr } = await supabase
    .from("sync_runs")
    .select("details")
    .eq("id", params.runId)
    .eq("user_id", params.userId)
    .maybeSingle();
  if (fetchErr || !run) {
    return { success: false, error: fetchErr?.message || "Sync run not found" };
  }

  const details = Array.isArray(run.details)
    ? ([...run.details] as ParsedTransactionResult[])
    : [];
  const idx = details.findIndex((d) => Number(d.sms_id) === params.smsId);
  if (idx >= 0) {
    details[idx] = params.newDetail;
  } else {
    details.push(params.newDetail);
  }

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  for (const d of details) {
    if (d.status === "inserted") inserted++;
    else if (d.status === "skipped") skipped++;
    else if (d.status === "error") errors++;
  }

  const totalMsgs = inserted + skipped + errors;
  const newStatus =
    totalMsgs === 0 ? "no_messages" :
    errors > 0 && inserted === 0 ? "failed" :
    errors > 0 ? "partial" :
    "success";

  const { error: updateErr } = await supabase
    .from("sync_runs")
    .update({
      details,
      inserted,
      skipped,
      errors,
      status: newStatus,
      total_messages: totalMsgs,
    })
    .eq("id", params.runId)
    .eq("user_id", params.userId);
  if (updateErr) {
    return { success: false, error: updateErr.message };
  }
  return { success: true };
}

/**
 * Delete any transaction matching (user_id, sms_id). No-op if none exists.
 */
export async function deleteTransactionBySmsId(
  userId: string,
  smsId: number
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from("transactions")
    .delete()
    .eq("user_id", userId)
    .eq("sms_id", smsId);

  if (error) {
    console.error("Failed to delete transaction by sms_id:", error.message);
    return { success: false, error: error.message };
  }
  return { success: true };
}

/**
 * Insert a sync run record
 */
export async function insertSyncRun(params: {
  userId: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  status: "success" | "partial" | "failed" | "no_messages";
  totalMessages: number;
  inserted: number;
  skipped: number;
  errors: number;
  messages: SMSMessage[];
  details: ParsedTransactionResult[];
  errorMessage?: string;
  source?: string;
  rowidRange?: { from: number; to: number };
  // Per-model token usage. Shape: { [modelId]: { input, output } }.
  // Null for failed runs that never produced AI usage data.
  usage?: Record<string, { input: number; output: number }> | null;
}): Promise<{ id: string | null; error?: string }> {
  const { data, error } = await supabase
    .from("sync_runs")
    .insert({
      user_id: params.userId,
      started_at: params.startedAt.toISOString(),
      completed_at: params.completedAt.toISOString(),
      duration_ms: params.durationMs,
      status: params.status,
      total_messages: params.totalMessages,
      inserted: params.inserted,
      skipped: params.skipped,
      errors: params.errors,
      messages: params.messages,
      details: params.details,
      error_message: params.errorMessage || null,
      source: params.source || "sms_sync",
      rowid_range: params.rowidRange || null,
      usage: params.usage ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to insert sync run:", error.message);
    return { id: null, error: error.message };
  }

  return { id: data?.id || null };
}
