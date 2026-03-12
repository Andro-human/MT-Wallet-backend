import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import type { Category, User, ParsedTransactionResult, SMSMessage, UserMerchantMapping } from "../types/index.js";
import type { TransactionInsert } from "../schemas/transaction.js";

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
    })
    .select("id")
    .single();

  if (error) {
    console.error("Failed to insert sync run:", error.message);
    return { id: null, error: error.message };
  }

  return { id: data?.id || null };
}
