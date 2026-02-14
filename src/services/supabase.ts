import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import type { Category, User } from "../types/index.js";
import type { TransactionInsert } from "../schemas/transaction.js";

// Create Supabase client with service role key (bypasses RLS)
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);

/**
 * Get user by API key
 */
export async function getUserByApiKey(apiKey: string): Promise<User | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("api_key", apiKey)
    .single();

  if (error || !data) {
    console.error("Failed to get user by API key:", error?.message);
    return null;
  }

  return { id: data.user_id };
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
 * Insert multiple transactions in batch
 */
export async function insertTransactions(
  transactions: TransactionInsert[]
): Promise<{ inserted: number; errors: number }> {
  let inserted = 0;
  let errors = 0;

  // Insert one by one to handle individual errors
  // Could optimize with batch insert if needed
  for (const txn of transactions) {
    const result = await insertTransaction(txn);
    if (result.success) {
      inserted++;
    } else {
      errors++;
    }
  }

  return { inserted, errors };
}
