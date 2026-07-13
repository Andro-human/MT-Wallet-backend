import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { parseAndCategorize, type ModelUsage } from "../services/ai.js";
import {
  getUserByApiKey,
  getCategories,
  insertTransactions,
  insertSyncRun,
  getUserMerchantMappings,
  getGmailWatchState,
  updateGmailWatchState,
  findTransactionByReferenceId,
  findCrossChannelDuplicate,
  getBankAccountAliases,
} from "../services/supabase.js";
import {
  findInBatchCrossChannelDuplicate,
  findInBatchReferenceIdDuplicate,
  buildAliasResolver,
  isAutomatedIngestSource,
} from "../services/deduplication.js";
import { withUserIngestLock } from "../services/ingest-lock.js";
import { convertToINR, isForeignCurrency } from "../services/currency.js";
import {
  cleanEmailBody,
  fetchNewMessagesSinceHistoryId,
  getLabelIdByName,
  isGmailFullyAuthed,
  verifyPubSubJWT,
} from "../services/gmail.js";
import { nullifyStringy } from "../services/sanitize.js";
import type { ParsedTransactionResult, SMSMessage, User } from "../types/index.js";
import type { TransactionInsert } from "../schemas/transaction.js";
import { env } from "../config/env.js";

const router = Router();

function sanitizeErrorForStorage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, "[REDACTED_GOOGLE_KEY]")
    .replace(/gsk_[A-Za-z0-9]{20,}/g, "[REDACTED_GROQ_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi, "Bearer [REDACTED_TOKEN]");
}

/**
 * Record a failed sync run for any post-auth failure. Always awaits so the row
 * lands before the handler returns, and never throws (catches its own errors).
 */
async function recordFailedSyncRun(params: {
  userId: string;
  startTime: number;
  messages: SMSMessage[];
  source: string;
  error: unknown;
  logPrefix: string;
}): Promise<string> {
  const errorMessage = sanitizeErrorForStorage(params.error);
  const smsIds = params.messages.map((m) => m.id);
  const rowidRange =
    smsIds.length > 0
      ? { from: Math.min(...smsIds), to: Math.max(...smsIds) }
      : undefined;

  try {
    await insertSyncRun({
      userId: params.userId,
      startedAt: new Date(params.startTime),
      completedAt: new Date(),
      durationMs: Date.now() - params.startTime,
      status: "failed",
      totalMessages: params.messages.length,
      inserted: 0,
      skipped: 0,
      errors: params.messages.length,
      messages: params.messages,
      details: [],
      errorMessage,
      source: params.source,
      rowidRange,
    });
  } catch (err) {
    console.error(`${params.logPrefix} Failed to record failed sync run:`, err);
  }

  return errorMessage;
}

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
  transactions?: { amount: number; direction: string; merchant: string | null }[];
}) {
  const shouldNotifyFailure = syncRun.status === "failed";
  const hasInsertedTransactions = (syncRun.inserted ?? 0) > 0;
  if (!hasInsertedTransactions && !shouldNotifyFailure) return;

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
 * Background processor shared by /shortcut-ingest and /pubsub-ingest.
 * Takes raw messages (without ids), assigns deterministic hash ids, runs AI
 * parsing + merchant overrides + currency conversion, bulk-inserts, records a
 * sync_run, and triggers a push notification. Never throws — failures are
 * recorded as failed sync_runs and surfaced via push.
 */
async function processMessagesInBackground(
  user: User,
  rawMessages: {
    sender: string;
    body: string;
    timestamp?: string;
    /** Email subject — Pass 1 uses this instead of body when present. */
    subject?: string;
  }[],
  source: "ios_shortcut" | "email",
  startTime: number,
  logPrefix: string,
): Promise<void> {
  return withUserIngestLock(user.id, () =>
    processMessagesInBackgroundUnlocked(user, rawMessages, source, startTime, logPrefix),
  );
}

async function processMessagesInBackgroundUnlocked(
  user: User,
  rawMessages: {
    sender: string;
    body: string;
    timestamp?: string;
    subject?: string;
  }[],
  source: "ios_shortcut" | "email",
  startTime: number,
  logPrefix: string,
): Promise<void> {
  let normalizedMessages: (SMSMessage & { timestamp: string })[] = [];
  try {
    console.log(
      `${logPrefix} User ${user.id.substring(0, 8)}... - ${rawMessages.length} messages`
    );

    // Normalize up-front so any downstream error can still record a sync_run with the batch
    normalizedMessages = rawMessages.map((msg) => {
      const senderStr = msg.sender || "Unknown";
      const bodyStr = msg.body || "";
      const timestampStr = msg.timestamp || "";
      const hashHex = crypto
        .createHash("sha256")
        .update(`${senderStr}|${bodyStr}|${timestampStr}`)
        .digest("hex")
        .substring(0, 13);
      const numericId = parseInt(hashHex, 16);
      return {
        id: numericId,
        sender: senderStr,
        body: bodyStr,
        timestamp: msg.timestamp || new Date().toISOString(),
        ...(msg.subject ? { subject: msg.subject } : {}),
      };
    });

    // Get categories and map for O(1) lookups
    const categories = await getCategories(user.id);
    const categoryMap = new Map(categories.map(c => [c.slug.toLowerCase(), c.id]));
    const categoryDefMap = new Map(categories.map(c => [c.id, c]));

    if (categories.length === 0) {
      console.warn(`${logPrefix} No categories found, transactions will have null category`);
    }

    // Get user merchant overrides (Phase 2 - Name map & default categorization/expense flags)
    const userOverrides = await getUserMerchantMappings(user.id);

    const aliasResolver = buildAliasResolver(await getBankAccountAliases(user.id));

    // Group overrides by raw_merchant
    const overridesMap = new Map<string, typeof userOverrides>();
    for (const override of userOverrides) {
      const key = override.raw_merchant.toLowerCase();
      if (!overridesMap.has(key)) overridesMap.set(key, []);
      overridesMap.get(key)!.push(override);
    }

    // Helper to evaluate if a rule matches
    const evaluateRule = (rule: typeof userOverrides[0], amount: number, currentMerchant: string, transactedAt: string) => {
      // 1. Check merchant name match based on match_type
      const ruleVal = rule.raw_merchant.toLowerCase();
      const currentVal = currentMerchant.toLowerCase();

      let isNameMatch = false;
      if (rule.match_type === 'contains') {
        isNameMatch = currentVal.includes(ruleVal);
      } else {
        isNameMatch = currentVal === ruleVal;
      }

      if (!isNameMatch) return false;

      // 2. Check amount conditions if specified
      if (rule.amount_operator && rule.amount_threshold !== null) {
        switch (rule.amount_operator) {
          case '<': if (!(amount < rule.amount_threshold)) return false; break;
          case '<=': if (!(amount <= rule.amount_threshold)) return false; break;
          case '>': if (!(amount > rule.amount_threshold)) return false; break;
          case '>=': if (!(amount >= rule.amount_threshold)) return false; break;
          case '=': if (!(amount === rule.amount_threshold)) return false; break;
        }
      }

      // 3. Check date conditions if specified
      if (rule.date_operator && rule.date_threshold !== null && transactedAt) {
        const txDate = new Date(transactedAt);
        const dayOfMonth = txDate.getDate(); // 1-31

        switch (rule.date_operator) {
          case '<': if (!(dayOfMonth < rule.date_threshold)) return false; break;
          case '<=': if (!(dayOfMonth <= rule.date_threshold)) return false; break;
          case '>': if (!(dayOfMonth > rule.date_threshold)) return false; break;
          case '>=': if (!(dayOfMonth >= rule.date_threshold)) return false; break;
          case '=': if (!(dayOfMonth === rule.date_threshold)) return false; break;
        }
      }

      // Passed all specified conditions
      return true;
    };

    // Parse and categorize with AI
    let parsed;
    let aiModelUsed = "unknown";
    let aiUsage: ModelUsage = {};
    try {
      const aiResult = await parseAndCategorize(normalizedMessages, categories);
      parsed = aiResult.parsed;
      aiModelUsed = aiResult.model;
      aiUsage = aiResult.usage;
    } catch (error) {
      console.error(`${logPrefix} AI parsing failed:`, error);
      await recordFailedSyncRun({
        userId: user.id,
        startTime,
        messages: normalizedMessages,
        source,
        error,
        logPrefix,
      });
      void triggerPushNotification({
        user_id: user.id,
        status: "failed",
        inserted: 0,
        skipped: 0,
        errors: normalizedMessages.length,
        total_messages: normalizedMessages.length,
      });
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
          ai_model: aiModelUsed,
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
          ai_model: aiModelUsed,
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
          ai_model: aiModelUsed,
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
          `${logPrefix} Converted ${originalCurrency} ${originalAmount} → ₹${amountINR} (rate: ${conversion.rate})`
        );
      }

      // Apply User Merchant Overrides
      let finalMerchant = txn.merchant || null;
      let finalCategoryId = txn.category_slug ? categoryMap.get(txn.category_slug.toLowerCase()) || null : null;

      let overriddenIsExpense: boolean | null = null;
      let overriddenIsIncome: boolean | null = null;
      let mappingApplied = false;

      if (finalMerchant) {
        let matchedRule: typeof userOverrides[0] | null = null;

        for (const rule of userOverrides) {
          if (evaluateRule(rule, amountINR, finalMerchant, msg.timestamp)) {
            matchedRule = rule;
            break; // Stop at first matched rule
          }
        }

        if (matchedRule) {
          console.log(`${logPrefix} [Override] Re-mapped merchant "${finalMerchant}" → "${matchedRule.mapped_merchant}"`);
          finalMerchant = matchedRule.mapped_merchant;
          mappingApplied = true;

          if (matchedRule.default_category_id) {
            finalCategoryId = matchedRule.default_category_id;
          }
          if (matchedRule.default_is_expense !== undefined && matchedRule.default_is_expense !== null) {
            overriddenIsExpense = matchedRule.default_is_expense;
          }
          if (matchedRule.default_is_income !== undefined && matchedRule.default_is_income !== null) {
            overriddenIsIncome = matchedRule.default_is_income;
          }
        }
      }

      if (!mappingApplied && finalMerchant) {
        finalMerchant = finalMerchant.toLowerCase().trim();
      }

      // Deterministic is_expense / is_income rules
      let is_expense = txn.direction === "debit";
      let is_income = txn.direction === "credit";

      const finalCategoryDef = finalCategoryId ? categoryDefMap.get(finalCategoryId) : null;
      const finalCategorySlug = finalCategoryDef?.slug || txn.category_slug;

      if (finalCategorySlug) {
        if (["investment", "self-transfer"].includes(finalCategorySlug)) {
          is_expense = false;
        }
        if (["self-transfer"].includes(finalCategorySlug)) {
          is_income = false;
        }
      }

      // Apply strict User Overrides for expense/income if they exist
      if (overriddenIsExpense !== null) is_expense = overriddenIsExpense;
      if (overriddenIsIncome !== null) is_income = overriddenIsIncome;

      // Prepare transaction for insert
      const cleanedMerchant = nullifyStringy(finalMerchant);
      const transactionData: TransactionInsert = {
        user_id: user.id,
        amount: amountINR,
        direction: txn.direction,
        transacted_at: msg.timestamp,
        merchant: cleanedMerchant,
        account_last4: nullifyStringy(txn.account_last4),
        bank_name: nullifyStringy(txn.bank_name),
        reference_id: nullifyStringy(txn.reference_id),
        raw_sms: msg.body,
        sms_id: msg.id,
        sms_sender: msg.sender,
        source,
        category_id: finalCategoryId,
        original_amount: originalAmount,
        original_currency: originalCurrency,
        is_expense,
        is_income,
        needs_review: user.enable_review_mode ?? true,
      };

      const parsedSummary = {
        amount: txn.amount,
        direction: txn.direction,
        merchant: nullifyStringy(txn.merchant),
        category: nullifyStringy(txn.category_slug),
      };

      // Layer 1: strong key (reference_id)
      if (transactionData.reference_id) {
        if (findInBatchReferenceIdDuplicate(transactionData.reference_id, transactionData.direction, transactionsToInsert)) {
          skipped++;
          details.push({
            sms_id: msg.id,
            status: "skipped",
            ai_model: aiModelUsed,
            reason: "Duplicate reference_id (same batch)",
            transaction: parsedSummary,
          });
          continue;
        }

        const existingRef = await findTransactionByReferenceId(
          user.id,
          transactionData.reference_id,
          transactionData.direction,
        );
        if (existingRef) {
          skipped++;
          details.push({
            sms_id: msg.id,
            status: "skipped",
            ai_model: aiModelUsed,
            reason: "Duplicate reference_id",
            transaction: parsedSummary,
          });
          continue;
        }
      }

      // Layer 2a: cross-channel soft fingerprint (phone ↔ email, 30 min).
      // No last4/bank gate — the fingerprint also merges wallet rows (no last4) on
      // matching merchant + bank, so gate only on the source being automated ingest.
      if (isAutomatedIngestSource(transactionData.source)) {
        if (findInBatchCrossChannelDuplicate(transactionData, transactionsToInsert, aliasResolver)) {
          skipped++;
          details.push({
            sms_id: msg.id,
            status: "skipped",
            ai_model: aiModelUsed,
            reason: "Cross-channel duplicate (same batch)",
            transaction: parsedSummary,
          });
          continue;
        }

        const crossChannel = await findCrossChannelDuplicate(user.id, transactionData, aliasResolver);
        if (crossChannel) {
          skipped++;
          details.push({
            sms_id: msg.id,
            status: "skipped",
            ai_model: aiModelUsed,
            reason: "Cross-channel duplicate (phone/email)",
            transaction: parsedSummary,
          });
          continue;
        }
      }

      transactionsToInsert.push(transactionData);

      details.push({
        sms_id: msg.id,
        status: "inserted",
        ai_model: aiModelUsed,
        transaction: parsedSummary,
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
      `${logPrefix} Completed in ${duration}ms - inserted: ${inserted}, skipped: ${skipped}, errors: ${errors}`
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
      source,
      rowidRange,
      usage: aiUsage,
    }).catch((err) => {
      console.error(`${logPrefix} Failed to record sync run:`, err);
    });

    // Trigger push notification directly (bypass broken DB webhook)
    triggerPushNotification({
      user_id: user.id,
      status: runStatus,
      inserted,
      skipped,
      errors,
      total_messages: normalizedMessages.length,
      transactions: details
        .filter(d => d.status === "inserted" && d.transaction)
        .map(d => ({ amount: d.transaction!.amount, direction: d.transaction!.direction, merchant: d.transaction!.merchant })),
    });
  } catch (error) {
    console.error(`${logPrefix} Background processing error:`, error);
    await recordFailedSyncRun({
      userId: user.id,
      startTime,
      messages: normalizedMessages,
      source,
      error,
      logPrefix,
    });
    void triggerPushNotification({
      user_id: user.id,
      status: "failed",
      inserted: 0,
      skipped: 0,
      errors: normalizedMessages.length,
      total_messages: normalizedMessages.length,
    });
  }
}

/**
 * POST /api/sms/shortcut-ingest
 *
 * Simplified endpoint for iOS Shortcuts automation.
 * Expects API key in x-api-key header and simplified message format.
 */
router.post("/shortcut-ingest", async (req: Request, res: Response) => {
  const startTime = Date.now();

  // DEBUG LOGGING
  console.log("\n==================================");
  console.log("[Shortcut Ingest] INCOMING PAYLOAD");
  console.log("[Shortcut Ingest] Headers:", JSON.stringify(req.headers, null, 2));
  console.log("[Shortcut Ingest] Body:", JSON.stringify(req.body, null, 2));
  console.log("==================================\n");

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
  void processMessagesInBackground(
    user,
    messages,
    "ios_shortcut",
    startTime,
    "[Shortcut Ingest]",
  );
});


// BigInt compare — Gmail historyIds can exceed Number.MAX_SAFE_INTEGER.
function maxHistoryId(a: string, b: string | null): string {
  if (!b) return a;
  try {
    return BigInt(a) >= BigInt(b) ? a : b;
  } catch {
    return a;
  }
}

/**
 * POST /api/sms/pubsub-ingest
 *
 * Gmail Pub/Sub push webhook. Pub/Sub POSTs here whenever Gmail's watch()
 * detects a change in the labeled mailbox. The body looks like:
 *   {
 *     "message": {
 *       "data": "<base64 JSON: { emailAddress, historyId }>",
 *       "messageId": "...",
 *       ...
 *     },
 *     "subscription": "projects/PROJECT/subscriptions/SUB"
 *   }
 *
 * Flow:
 *   1. Verify JWT (if GCP_PUBSUB_PUSH_AUDIENCE is set).
 *   2. ACK 200 immediately so Pub/Sub doesn't retry on slow downstream work.
 *   3. In background: decode the payload, look up the target user, call
 *      gmail.users.history.list(startHistoryId = stored cursor), fetch each
 *      newly-labeled message, normalize to our message shape, and dispatch
 *      to processMessagesInBackground. Advance the cursor on success.
 */
router.post("/pubsub-ingest", async (req: Request, res: Response) => {
  const startTime = Date.now();

  const authOk = await verifyPubSubJWT(req.headers.authorization);
  if (!authOk) {
    res.status(401).json({ success: false, error: "Invalid Pub/Sub auth" });
    return;
  }

  // ACK first so Pub/Sub never times out (10s default) or retries on slow processing.
  res.status(200).json({ success: true });

  void (async () => {
    try {
      const message = req.body?.message;
      if (!message?.data) {
        console.error("[Pub/Sub] Missing message.data in payload");
        return;
      }

      let decoded: { emailAddress?: string; historyId?: string | number };
      try {
        decoded = JSON.parse(Buffer.from(message.data, "base64").toString("utf-8"));
      } catch (err) {
        console.error("[Pub/Sub] Failed to base64-decode message.data:", err);
        return;
      }

      const notifHistoryId = decoded.historyId ? String(decoded.historyId) : undefined;
      console.log(
        `[Pub/Sub] Notification: emailAddress=${decoded.emailAddress} historyId=${notifHistoryId}`
      );

      if (!isGmailFullyAuthed()) {
        console.error("[Pub/Sub] Gmail not fully configured — set GOOGLE_REFRESH_TOKEN");
        return;
      }
      if (!env.gmailTargetUserApiKey) {
        console.error("[Pub/Sub] GMAIL_TARGET_USER_API_KEY not set");
        return;
      }
      if (!notifHistoryId) {
        console.error("[Pub/Sub] Notification missing historyId");
        return;
      }

      const user = await getUserByApiKey(env.gmailTargetUserApiKey);
      if (!user) {
        console.error("[Pub/Sub] No user found for GMAIL_TARGET_USER_API_KEY");
        return;
      }

      // The lock must span read-cursor → fetch → process → advance so concurrent
      // notifications don't both read the same stale cursor and double-process.
      // Call the *Unlocked* processor inside — withUserIngestLock is non-reentrant
      // and nesting it for the same user deadlocks.
      await withUserIngestLock(user.id, async () => {
        const state = await getGmailWatchState(user.id);
        if (!state?.lastHistoryId) {
          // No cursor yet — most likely watch() hasn't been called. Seed from
          // the notification and wait for the next one. We lose this batch but
          // the next notification will advance correctly.
          console.warn(
            `[Pub/Sub] No last_history_id baseline — seeding to ${notifHistoryId} and skipping this batch`
          );
          await updateGmailWatchState(user.id, { lastHistoryId: notifHistoryId });
          return;
        }

        const labelId = await getLabelIdByName(env.gmailLabelName);

        let result;
        try {
          result = await fetchNewMessagesSinceHistoryId(state.lastHistoryId, labelId);
        } catch (err) {
          // Reset the cursor only on 404 (cursor too old). On transient errors
          // it must stay put — Pub/Sub was already ACKed so there's no
          // redelivery; the next notification re-fetches the same range.
          const status = (err as { response?: { status?: number }; code?: number | string }).response?.status
            ?? (err as { code?: number | string }).code;
          const msg = (err as Error).message || String(err);
          if (status === 404 || status === "404") {
            console.error(`[Pub/Sub] history cursor too old (${msg}) — resetting cursor to ${notifHistoryId}`);
            await updateGmailWatchState(user.id, { lastHistoryId: notifHistoryId });
          } else {
            console.error(`[Pub/Sub] history.list failed transiently (${msg}) — keeping cursor for retry on next notification`);
          }
          return;
        }

        const fetched = result.messages;
        console.log(`[Pub/Sub] Fetched ${fetched.length} new labeled message(s)`);

        if (fetched.length > 0) {
          // Clean + truncate once here. The result is both the AI's Pass 2 input
          // AND what we store as raw_sms — single source of truth, smaller DB rows.
          const raw = fetched.map((m) => ({
            sender: m.sender,
            subject: m.subject,
            body: cleanEmailBody(m.body),
            timestamp: m.timestamp,
          }));
          await processMessagesInBackgroundUnlocked(user, raw, "email", startTime, "[Pub/Sub Ingest]");
        }

        // Advance to the newest historyId the fetch covered, not the notification's
        // (which can be older), or newer messages get re-fetched on every notification.
        const advanceTo = maxHistoryId(notifHistoryId, result.latestHistoryId);
        await updateGmailWatchState(user.id, { lastHistoryId: advanceTo });
      });
    } catch (err) {
      console.error("[Pub/Sub] Background processing error:", err);
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
