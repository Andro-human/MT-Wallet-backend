import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { IngestRequestSchema } from "../schemas/transaction.js";
import { parseAndCategorize } from "../services/ai.js";
import {
  getUserByApiKey,
  getCategories,
  insertTransactions,
  insertSyncRun,
  getUserMerchantMappings,
} from "../services/supabase.js";
import { convertToINR, isForeignCurrency } from "../services/currency.js";
import type { IngestResponse, ParsedTransactionResult } from "../types/index.js";
import type { TransactionInsert } from "../schemas/transaction.js";
import { env } from "../config/env.js";

const router = Router();

/**
 * Trigger push notification via Supabase Edge Function
 */
async function triggerPushNotification(syncRun: {
  id?: string;
  user_id: string;
  status: string;
  inserted: number;
  skipped: number;
  errors: number;
  total_messages: number;
}) {
  if (!syncRun.inserted || syncRun.inserted === 0) return;

  try {
    const response = await fetch(
      `${env.supabaseUrl}/functions/v1/send-push-notification`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.supabaseServiceRoleKey}`,
        },
        body: JSON.stringify({
          type: "INSERT",
          table: "sync_runs",
          record: syncRun,
        }),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[Push] Edge Function returned ${response.status}: ${text}`);
    } else {
      const result = await response.json().catch(() => null);
      console.log(`[Push] Notification triggered:`, result);
    }
  } catch (err) {
    console.error("[Push] Failed to trigger notification:", err);
  }
}

/**
 * POST /api/sms/ingest
 *
 * Receives raw SMS messages, parses them with AI, categorizes, and inserts transactions.
 */
router.post("/ingest", async (req: Request, res: Response) => {
  const startTime = Date.now();

  // Validate request body
  const parseResult = IngestRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      success: false,
      error: "Invalid request body",
      details: parseResult.error.errors,
    });
    return;
  }

  const { messages, api_key } = parseResult.data;

  // Validate API key and get user
  const user = await getUserByApiKey(api_key);
  if (!user) {
    res.status(401).json({
      success: false,
      error: "Invalid API key",
    });
    return;
  }

  console.log(
    `[SMS Ingest] User ${user.id.substring(0, 8)}... - ${messages.length} messages`
  );

  // Get categories and map for O(1) lookups
  const categories = await getCategories(user.id);
  const categoryMap = new Map(categories.map(c => [c.slug.toLowerCase(), c.id]));
  const categoryDefMap = new Map(categories.map(c => [c.id, c]));

  if (categories.length === 0) {
    console.warn("No categories found, transactions will have null category");
  }

  // Get user merchant overrides (Phase 2 - Name map & default categorization/expense flags)
  const userOverrides = await getUserMerchantMappings(user.id);
  const overridesMap = new Map(userOverrides.map(o => [o.raw_merchant.toLowerCase(), o]));

  // Parse and categorize with AI
  let parsed;
  try {
    parsed = await parseAndCategorize(messages, categories);
  } catch (error) {
    console.error("[SMS Ingest] AI parsing failed:", error);
    res.status(500).json({
      success: false,
      error: "Failed to parse SMS with AI",
      details: String(error),
    });
    return;
  }

  // Build a lookup map from sms_id → parsed result (more robust than index matching)
  const parsedMap = new Map(parsed.map((p) => [p.sms_id, p]));

  // Process each parsed result
  const transactionsToInsert: TransactionInsert[] = [];
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const details: ParsedTransactionResult[] = [];

  for (const msg of messages) {
    const txn = parsedMap.get(msg.id);

    // Handle case where AI didn't return result for this message
    if (!txn) {
      skipped++;
      details.push({
        sms_id: msg.id,
        status: "skipped",
        reason: "No AI result for this message",
      });
      continue;
    }

    // Skip non-transactions
    if (!txn.is_transaction) {
      skipped++;
      details.push({
        sms_id: msg.id,
        status: "skipped",
        reason: txn.skip_reason || "Not a transaction",
      });
      continue;
    }

    // Validate required fields for transactions
    if (!txn.amount || !txn.direction) {
      skipped++;
      details.push({
        sms_id: msg.id,
        status: "skipped",
        reason: "Missing amount or direction",
      });
      continue;
    }

    // Handle currency conversion
    const currency = txn.currency || "INR";
    let amountINR = txn.amount;
    let originalAmount: number | null = null;
    let originalCurrency: string | null = null;

    if (isForeignCurrency(currency)) {
      const conversion = await convertToINR(txn.amount, currency);
      amountINR = conversion.amountINR;
      originalAmount = txn.amount;
      originalCurrency = currency.toUpperCase();
      console.log(
        `[Currency] Converted ${originalCurrency} ${originalAmount} → ₹${amountINR} (rate: ${conversion.rate})`
      );
    }

    let finalCategoryId = txn.category_slug ? categoryMap.get(txn.category_slug.toLowerCase()) || null : null;
    let finalMerchant = txn.merchant || null;

    let overriddenIsExpense: boolean | null = null;
    let overriddenIsIncome: boolean | null = null;

    if (finalMerchant) {
      const override = overridesMap.get(finalMerchant.toLowerCase());

      if (override) {
        console.log(`[Override] Re-mapped merchant "${finalMerchant}" → "${override.mapped_merchant}"`);
        finalMerchant = override.mapped_merchant;

        if (override.default_category_id) {
          finalCategoryId = override.default_category_id;
        }
        if (override.default_is_expense !== undefined && override.default_is_expense !== null) {
          overriddenIsExpense = override.default_is_expense;
        }
        if (override.default_is_income !== undefined && override.default_is_income !== null) {
          overriddenIsIncome = override.default_is_income;
        }
      }
    }

    // Deterministic is_expense / is_income rules
    let is_expense = txn.direction === "debit";
    let is_income = txn.direction === "credit";

    const finalCategoryDef = finalCategoryId ? categoryDefMap.get(finalCategoryId) : null;
    const finalCategorySlug = finalCategoryDef?.slug || txn.category_slug;

    if (finalCategorySlug) {
      if (["transfer", "investment", "bill-payment", "emi", "lent"].includes(finalCategorySlug)) {
        is_expense = false;
      }
      if (["transfer", "refund"].includes(finalCategorySlug)) {
        is_income = false;
      }
    }

    // Apply strict User Overrides for expense/income if they exist
    if (overriddenIsExpense !== null) is_expense = overriddenIsExpense;
    if (overriddenIsIncome !== null) is_income = overriddenIsIncome;

    // Prepare transaction for insert
    const transactionData = {
      user_id: user.id,
      amount: amountINR,
      direction: txn.direction,
      transacted_at: msg.timestamp || new Date().toISOString(),
      merchant: finalMerchant,
      merchant_normalized: finalMerchant, // Could normalize later
      account_last4: txn.account_last4 || null,
      bank_name: txn.bank_name || null,
      reference_id: txn.reference_id || null,
      raw_sms: msg.body,
      sms_id: msg.id,
      sms_sender: msg.sender,
      source: "sms" as const,
      category_id: finalCategoryId,
      original_amount: originalAmount,
      original_currency: originalCurrency,
      is_expense,
      is_income,
    };

    // Accumulate transaction for bulk insert
    transactionsToInsert.push(transactionData);

    // Add success detail immediately (will track DB errors in the bulk wrapper if needed, 
    // or assume success since we are optimistically building the array)
    details.push({
      sms_id: msg.id,
      status: "inserted",
      transaction: {
        amount: txn.amount,
        direction: txn.direction,
        merchant: txn.merchant || null,
        category: txn.category_slug || null,
      },
    });
  }

  // Perform bulk insert
  if (transactionsToInsert.length > 0) {
    const bulkResult = await insertTransactions(transactionsToInsert);
    inserted = bulkResult.inserted;
    errors = bulkResult.errors;

    // For absolute accuracy we'd map bulk errors back to `details`, 
    // but the original code also just pushed to arrays and counted.
  }

  const completedAt = new Date();
  const duration = Date.now() - startTime;
  console.log(
    `[SMS Ingest] Completed in ${duration}ms - inserted: ${inserted}, skipped: ${skipped}, errors: ${errors}`
  );

  // Determine run status
  const runStatus = errors > 0 && inserted === 0
    ? "failed"
    : errors > 0
      ? "partial"
      : "success";

  // Calculate ROWID range
  const smsIds = messages.map((m) => m.id);
  const rowidRange = smsIds.length > 0
    ? { from: Math.min(...smsIds), to: Math.max(...smsIds) }
    : undefined;

  // Record sync run in database (fire-and-forget, don't block response)
  const syncRunPromise = insertSyncRun({
    userId: user.id,
    startedAt: new Date(startTime),
    completedAt,
    durationMs: duration,
    status: runStatus,
    totalMessages: messages.length,
    inserted,
    skipped,
    errors,
    messages,
    details,
    source: "sms_sync",
    rowidRange,
  }).catch((err) => {
    console.error("[SMS Ingest] Failed to record sync run:", err);
  });

  const response: IngestResponse = {
    success: true,
    inserted,
    skipped,
    errors,
    total: messages.length,
    details,
  };

  res.json(response);

  // Await sync run insert after response is sent
  await syncRunPromise;

  // Trigger push notification directly (bypass broken DB webhook)
  triggerPushNotification({
    user_id: user.id,
    status: runStatus,
    inserted,
    skipped,
    errors,
    total_messages: messages.length,
  });
});

/**
 * POST /api/sms/shortcut-ingest
 *
 * Simplified endpoint for iOS Shortcuts automation.
 * Expects API key in x-api-key header and simplified message format.
 */
router.post("/shortcut-ingest", async (req: Request, res: Response) => {
  const startTime = Date.now();

  // Extract API key from header
  const apiKey = req.headers["x-api-key"] as string;
  if (!apiKey) {
    res.status(401).json({
      success: false,
      error: "Missing x-api-key header",
    });
    return;
  }

  // Validate API key and get user
  const user = await getUserByApiKey(apiKey);
  if (!user) {
    res.status(401).json({
      success: false,
      error: "Invalid API key",
    });
    return;
  }

  // Validate request body structure
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({
      success: false,
      error: "Missing or empty messages array",
    });
    return;
  }

  // Return success immediately to prevent Shortcut timeout
  res.json({ success: true });

  // Continue processing in background
  (async () => {
    try {
      console.log(
        `[Shortcut Ingest] User ${user.id.substring(0, 8)}... - ${messages.length} messages`
      );

      // Get categories and map for O(1) lookups
      const categories = await getCategories(user.id);
      const categoryMap = new Map(categories.map(c => [c.slug.toLowerCase(), c.id]));
      const categoryDefMap = new Map(categories.map(c => [c.id, c]));

      if (categories.length === 0) {
        console.warn("[Shortcut Ingest] No categories found, transactions will have null category");
      }

      // Get user merchant overrides (Phase 2 - Name map & default categorization/expense flags)
      const userOverrides = await getUserMerchantMappings(user.id);
      const overridesMap = new Map(userOverrides.map(o => [o.raw_merchant.toLowerCase(), o]));

      // Transform iOS Shortcut format to internal format
      const normalizedMessages = messages.map((msg: any) => {
        const senderStr = msg.sender || "Unknown";
        const bodyStr = msg.body || "";

        // Generate a deterministic numeric ID from sender + body hash to prevent duplicates
        // We use the first 13 hex characters of SHA-256 (52 bits) to fit within JS MAX_SAFE_INTEGER
        const hashHex = crypto
          .createHash("sha256")
          .update(`${senderStr}|${bodyStr}`)
          .digest("hex")
          .substring(0, 13);
        const numericId = parseInt(hashHex, 16);

        return {
          id: numericId,
          sender: senderStr,
          body: bodyStr,
          timestamp: msg.timestamp || new Date().toISOString()
        };
      });

      // Parse and categorize with AI
      let parsed;
      try {
        parsed = await parseAndCategorize(normalizedMessages, categories);
      } catch (error) {
        console.error("[Shortcut Ingest] AI parsing failed:", error);
        return;
      }

      // Build a lookup map from sms_id → parsed result
      const parsedMap = new Map(parsed.map((p) => [p.sms_id, p]));

      // Process each parsed result
      const transactionsToInsert: TransactionInsert[] = [];
      let inserted = 0;
      let skipped = 0;
      let errors = 0;
      const details: ParsedTransactionResult[] = [];

      for (const msg of normalizedMessages) {
        const txn = parsedMap.get(msg.id);

        // Handle case where AI didn't return result for this message
        if (!txn) {
          skipped++;
          details.push({
            sms_id: msg.id,
            status: "skipped",
            reason: "No AI result for this message",
          });
          continue;
        }

        // Skip non-transactions
        if (!txn.is_transaction) {
          skipped++;
          details.push({
            sms_id: msg.id,
            status: "skipped",
            reason: txn.skip_reason || "Not a transaction",
          });
          continue;
        }

        // Validate required fields for transactions
        if (!txn.amount || !txn.direction) {
          skipped++;
          details.push({
            sms_id: msg.id,
            status: "skipped",
            reason: "Missing amount or direction",
          });
          continue;
        }

        // Handle currency conversion
        const currency = txn.currency || "INR";
        let amountINR = txn.amount;
        let originalAmount: number | null = null;
        let originalCurrency: string | null = null;

        if (isForeignCurrency(currency)) {
          const conversion = await convertToINR(txn.amount, currency);
          amountINR = conversion.amountINR;
          originalAmount = txn.amount;
          originalCurrency = currency.toUpperCase();
          console.log(
            `[Shortcut Ingest] Converted ${originalCurrency} ${originalAmount} → ₹${amountINR} (rate: ${conversion.rate})`
          );
        }

        // Apply User Merchant Overrides
        let finalMerchant = txn.merchant || null;
        let finalCategoryId = txn.category_slug ? categoryMap.get(txn.category_slug.toLowerCase()) || null : null;

        let overriddenIsExpense: boolean | null = null;
        let overriddenIsIncome: boolean | null = null;

        if (finalMerchant) {
          const override = overridesMap.get(finalMerchant.toLowerCase());

          if (override) {
            console.log(`[Shortcut Ingest Override] Re-mapped merchant "${finalMerchant}" → "${override.mapped_merchant}"`);
            finalMerchant = override.mapped_merchant;

            if (override.default_category_id) {
              finalCategoryId = override.default_category_id;
            }
            if (override.default_is_expense !== undefined && override.default_is_expense !== null) {
              overriddenIsExpense = override.default_is_expense;
            }
            if (override.default_is_income !== undefined && override.default_is_income !== null) {
              overriddenIsIncome = override.default_is_income;
            }
          }
        }

        // Deterministic is_expense / is_income rules
        let is_expense = txn.direction === "debit";
        let is_income = txn.direction === "credit";

        const finalCategoryDef = finalCategoryId ? categoryDefMap.get(finalCategoryId) : null;
        const finalCategorySlug = finalCategoryDef?.slug || txn.category_slug;

        if (finalCategorySlug) {
          if (["transfer", "investment", "bill-payment", "emi", "lent"].includes(finalCategorySlug)) {
            is_expense = false;
          }
          if (["transfer", "refund"].includes(finalCategorySlug)) {
            is_income = false;
          }
        }

        // Apply strict User Overrides for expense/income if they exist
        if (overriddenIsExpense !== null) is_expense = overriddenIsExpense;
        if (overriddenIsIncome !== null) is_income = overriddenIsIncome;

        // Prepare transaction for insert
        const transactionData = {
          user_id: user.id,
          amount: amountINR,
          direction: txn.direction,
          transacted_at: msg.timestamp,
          merchant: finalMerchant,
          merchant_normalized: finalMerchant,
          account_last4: txn.account_last4 || null,
          bank_name: txn.bank_name || null,
          reference_id: txn.reference_id || null,
          raw_sms: msg.body,
          sms_id: msg.id,
          sms_sender: msg.sender,
          source: "ios_shortcut" as const,
          category_id: finalCategoryId,
          original_amount: originalAmount,
          original_currency: originalCurrency,
          is_expense,
          is_income,
        };

        // Accumulate transaction for bulk insert
        transactionsToInsert.push(transactionData);

        details.push({
          sms_id: msg.id,
          status: "inserted",
          transaction: {
            amount: txn.amount,
            direction: txn.direction,
            merchant: txn.merchant || null,
            category: txn.category_slug || null,
          },
        });
      }

      // Perform bulk insert
      if (transactionsToInsert.length > 0) {
        const bulkResult = await insertTransactions(transactionsToInsert);
        inserted = bulkResult.inserted;
        errors = bulkResult.errors;
      }

      const completedAt = new Date();
      const duration = Date.now() - startTime;
      console.log(
        `[Shortcut Ingest] Completed in ${duration}ms - inserted: ${inserted}, skipped: ${skipped}, errors: ${errors}`
      );

      // Determine run status
      const runStatus = errors > 0 && inserted === 0
        ? "failed"
        : errors > 0
          ? "partial"
          : "success";

      // Calculate ROWID range
      const smsIds = normalizedMessages.map((m) => m.id);
      const rowidRange = smsIds.length > 0
        ? { from: Math.min(...smsIds), to: Math.max(...smsIds) }
        : undefined;

      // Record sync run in database
      await insertSyncRun({
        userId: user.id,
        startedAt: new Date(startTime),
        completedAt,
        durationMs: duration,
        status: runStatus,
        totalMessages: normalizedMessages.length,
        inserted,
        skipped,
        errors,
        messages: normalizedMessages,
        details,
        source: "ios_shortcut",
        rowidRange,
      }).catch((err) => {
        console.error("[Shortcut Ingest] Failed to record sync run:", err);
      });

      // Trigger push notification directly (bypass broken DB webhook)
      triggerPushNotification({
        user_id: user.id,
        status: runStatus,
        inserted,
        skipped,
        errors,
        total_messages: normalizedMessages.length,
      });
    } catch (error) {
      console.error("[Shortcut Ingest] Background processing error:", error);
    }
  })();
});

/**
 * GET /api/sms/health
 *
 * Health check endpoint
 */
router.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default router;
