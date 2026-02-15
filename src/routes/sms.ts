import { Router, type Request, type Response } from "express";
import { IngestRequestSchema } from "../schemas/transaction.js";
import { parseAndCategorize } from "../services/ai.js";
import {
  getUserByApiKey,
  getCategories,
  getCategoryIdBySlug,
  insertTransaction,
  insertSyncRun,
} from "../services/supabase.js";
import { convertToINR, isForeignCurrency } from "../services/currency.js";
import type { IngestResponse, ParsedTransactionResult } from "../types/index.js";

const router = Router();

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

  // Get categories for categorization
  const categories = await getCategories(user.id);
  if (categories.length === 0) {
    console.warn("No categories found, transactions will have null category");
  }

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

    // Get category ID from slug
    const categoryId = getCategoryIdBySlug(txn.category_slug, categories);

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

    // Determine is_expense / is_income
    const is_expense = txn.direction === "debit" ? (txn.is_expense ?? true) : false;
    const is_income = txn.direction === "credit" ? (txn.is_income ?? true) : false;

    // Prepare transaction for insert
    const transactionData = {
      user_id: user.id,
      amount: amountINR,
      direction: txn.direction,
      transacted_at: msg.timestamp || new Date().toISOString(),
      merchant: txn.merchant || null,
      merchant_normalized: txn.merchant || null, // Could normalize later
      payment_method: txn.payment_method || null,
      account_last4: txn.account_last4 || null,
      bank_name: txn.bank_name || null,
      reference_id: txn.reference_id || null,
      raw_sms: msg.body,
      sms_id: msg.id,
      sms_sender: msg.sender,
      source: "sms" as const,
      category_id: categoryId,
      original_amount: originalAmount,
      original_currency: originalCurrency,
      is_expense,
      is_income,
    };

    // Insert transaction
    const result = await insertTransaction(transactionData);

    if (result.success) {
      inserted++;
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
    } else {
      errors++;
      details.push({
        sms_id: msg.id,
        status: "error",
        reason: result.error || "Insert failed",
      });
    }
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
