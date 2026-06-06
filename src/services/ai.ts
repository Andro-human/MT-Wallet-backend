import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { z } from "zod";
import type { SMSMessage, Category } from "../types/index.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

// Public-facing parsed-transaction shape consumed by /ingest and
// /shortcut-ingest. Produced by `parseAndCategorize`'s two-pass merge.
const TransactionOutputSchema = z.object({
  sms_id: z.number().describe("The SMS message ID from input"),
  is_transaction: z
    .boolean()
    .describe("True if this SMS represents a real financial transaction"),

  // Transaction details (only when is_transaction is true)
  amount: z
    .number()
    .positive()
    .optional()
    .describe("Transaction amount as shown in SMS (e.g., 5.90 for 'USD 5.90', 296.00 for 'INR 296.00')"),
  currency: z
    .string()
    .optional()
    .describe("Currency code: 'INR', 'USD', 'EUR', 'GBP', etc. Default to 'INR' if not specified"),
  direction: z
    .enum(["credit", "debit"])
    .optional()
    .describe("credit = money received, debit = money spent"),
  merchant: z
    .string()
    .nullable()
    .optional()
    .describe("Merchant or sender name, or UPI ID"),
  account_last4: z
    .string()
    .nullable()
    .optional()
    .describe("Last 4 digits of card/account number"),
  bank_name: z.string().nullable().optional().describe("Bank name"),
  reference_id: z
    .string()
    .nullable()
    .optional()
    .describe("Per-transaction bank ref (UPI Ref / RRN / Txn ID / IMPS Ref). Null if only a mandate / Standing Instruction / order / customer ID is present — those aren't transaction refs."),
  category_slug: z
    .string()
    .nullable()
    .optional()
    .describe("Category slug from the allowed list"),
  confidence: z
    .enum(["high", "medium", "low"])
    .optional()
    .describe("Confidence in the parsing accuracy"),

  // Skip reason (only when is_transaction is false)
  skip_reason: z
    .string()
    .nullable()
    .optional()
    .describe("Why this SMS is not a transaction"),
});

// Extraction-only schema (single-message), used by the /reclassify endpoint
// when the user has already decided the SMS is a transaction and we just need
// to pull the literal fields. Every field is nullable so the model has no
// incentive to invent values (e.g. mistaking an OTP code for an amount).
const ExtractedFieldsSchema = z.object({
  amount: z
    .number()
    .positive()
    .nullable()
    .describe("Transaction amount as shown in SMS (e.g., 5.90 for 'USD 5.90', 296.00 for 'INR 296.00'). Null if not clearly stated."),
  currency: z
    .string()
    .nullable()
    .describe("Currency code: 'INR', 'USD', 'EUR', 'GBP', etc. Default to 'INR' if not specified."),
  direction: z
    .enum(["credit", "debit"])
    .nullable()
    .describe("credit = money received, debit = money spent. Null if neither is clearly indicated."),
  merchant: z
    .string()
    .nullable()
    .describe("Merchant or sender name, or UPI ID."),
  account_last4: z
    .string()
    .nullable()
    .describe("Last 4 digits of card/account number."),
  bank_name: z
    .string()
    .nullable()
    .describe("Bank name."),
  reference_id: z
    .string()
    .nullable()
    .describe("Per-transaction bank ref (UPI Ref / RRN / Txn ID / IMPS Ref). Null if only a mandate / Standing Instruction / order / customer ID is present."),
  category_slug: z
    .string()
    .nullable()
    .describe("Category slug from the allowed list provided in the prompt."),
});

// Two-pass ingest schemas. Pass 1 returns is_transaction per message (tiny
// schema, runs on the cheap classifier model). Pass 2 returns extracted fields
// keyed by sms_id, but only for messages classified as transactions.
const ClassificationItemSchema = z.object({
  sms_id: z.number().describe("The SMS message ID from input"),
  is_transaction: z
    .boolean()
    .describe(
      "True only when the SMS confirms money has ALREADY moved (past-tense: debited/credited/spent/received/paid/transferred/withdrawn). False for OTPs, payment authorization, balance checks, statements, promotions, or any pending/upcoming wording — even when amount/merchant/card are mentioned.",
    ),
  skip_reason: z
    .string()
    .nullable()
    .optional()
    .describe("Brief reason when is_transaction is false (e.g. 'OTP', 'Balance notification'). Null/omitted when is_transaction is true."),
});
const ClassificationsArraySchema = z.array(ClassificationItemSchema);

const BatchExtractedItemSchema = ExtractedFieldsSchema.extend({
  sms_id: z.number().describe("The SMS message ID from input"),
});
const BatchExtractedArraySchema = z.array(BatchExtractedItemSchema);

// ── Exported types ─────────────────────────────────────────────────────────

export type ParsedTransaction = z.infer<typeof TransactionOutputSchema>;
export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;

/**
 * Per-model token usage, keyed by model id (e.g. "gemini-2.5-flash-lite").
 * Multiple calls to the same model accumulate into the same bucket so a
 * sync_run that hits classifier + extractor (different models) shows two
 * entries, while one that falls back to the same model twice shows one.
 */
export type ModelUsage = Record<string, { input: number; output: number }>;

export interface ParseAndCategorizeResult {
  parsed: ParsedTransaction[];
  model: string;
  usage: ModelUsage;
}

// ── Constants ──────────────────────────────────────────────────────────────

// Extractor model: needs to reason about structured field extraction.
const PRIMARY_PROVIDER = "google";
const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_PROVIDER = "groq";
const FALLBACK_MODEL = "llama-3.3-70b-versatile";

// Classifier model: tiny task (yes/no + skip reason). Use the cheapest
// reliable Google tier; falls back to the same Groq model as extraction.
// 90%+ of incoming SMS are non-transactional, so this pass shoulders most of
// the per-batch work.
const CLASSIFIER_MODEL = "gemini-2.5-flash-lite";

const MAX_ATTEMPTS = 2;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

// ── Low-level helpers ──────────────────────────────────────────────────────

function getModel(provider: "google" | "groq", modelId: string) {
  return provider === "google" ? google(modelId) : groq(modelId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : "Unknown error";
  return msg
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, "[REDACTED_GOOGLE_KEY]")
    .replace(/gsk_[A-Za-z0-9]{20,}/g, "[REDACTED_GROQ_KEY]");
}

/**
 * When generateObject throws because the model output didn't validate against
 * the schema, the raw text is often tucked into `error.cause.value`. Try to
 * parse that and validate it against `arraySchema` — recovers from minor JSON
 * envelope issues without needing a full retry.
 */
function tryRecoverArrayFromError<T extends z.ZodTypeAny>(
  error: unknown,
  arraySchema: z.ZodArray<T>,
): z.infer<typeof arraySchema> | null {
  if (!(error instanceof Error)) return null;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return null;
  const value = (cause as { value?: unknown }).value;
  if (!value) return null;

  const parseValue = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    const trimmed = v.trim();
    if (!trimmed) return v;
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  };

  const parsedValue = parseValue(value);
  if (Array.isArray(parsedValue)) {
    const validated = arraySchema.safeParse(parsedValue);
    return validated.success ? validated.data : null;
  }

  if (parsedValue && typeof parsedValue === "object") {
    const validated = arraySchema.safeParse([parsedValue]);
    return validated.success ? validated.data : null;
  }

  return null;
}

type CallResult<T> = { data: T; input: number; output: number };

/** Accumulate per-model token usage into an aggregator map (mutates in place). */
function addUsage(into: ModelUsage, model: string, input: number, output: number) {
  const bucket = into[model] ?? { input: 0, output: 0 };
  bucket.input += input;
  bucket.output += output;
  into[model] = bucket;
}

async function callModelWithRetry<T extends z.ZodTypeAny>(
  provider: "google" | "groq",
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodArray<T>,
): Promise<CallResult<z.infer<z.ZodArray<T>>>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(
        `[ai] Calling ${modelId} attempt ${attempt}/${MAX_ATTEMPTS} (provider=${provider})`
      );

      const result = await generateObject({
        model: getModel(provider, modelId),
        schema,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0,
        maxRetries: 0, // retries handled here so we control backoff + logging
      });
      if (attempt > 1) {
        console.log(`[ai] ${modelId} succeeded on attempt ${attempt}/${MAX_ATTEMPTS}`);
      }
      return {
        data: result.object,
        input: result.usage?.promptTokens ?? 0,
        output: result.usage?.completionTokens ?? 0,
      };
    } catch (error) {
      const recovered = tryRecoverArrayFromError(error, schema);
      if (recovered) {
        // Recovered output didn't go through generateObject's usage tally — we
        // don't have a reliable token count for these. Report 0 so the row is
        // visibly suspicious in the UI rather than over- or under-counting.
        console.warn(`[ai] ${modelId} recovered structured output from provider error envelope (usage unknown)`);
        return { data: recovered, input: 0, output: 0 };
      }
      lastError = error;
      const message = sanitizeErrorMessage(error);
      console.warn(
        `[ai] ${modelId} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${message}`
      );
      if (attempt < MAX_ATTEMPTS) {
        const expDelay = BASE_DELAY_MS * 2 ** (attempt - 1);
        const jitter = Math.random() * 250;
        const delay = Math.min(expDelay + jitter, MAX_DELAY_MS);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// ── Pass 1: classify ───────────────────────────────────────────────────────

const CLASSIFY_SYSTEM_PROMPT = `You classify Indian banking SMS as financial transactions.

YES: past-tense verb describing money moving — debited, credited, spent, received, paid, transferred, withdrawn, used, swiped, charged.

NO: OTP / verification, payment authorization, standalone balance / statement, promo, pending / upcoming / scheduled — even if an amount, merchant, or card is mentioned.

Output one object per input, same order. Copy sms_id EXACTLY.`;

const EMAIL_CLASSIFY_SYSTEM_PROMPT = `You classify emails as financial transactions. Each input has sender, subject, body_preview.

YES when BOTH:
1. Sender is a bank / card / wallet / payment service.
2. Subject OR body_preview shows past-tense money movement: debited, credited, spent, paid, charged, received, withdrawn, transferred, refunded, reversed, "card used", "payment made", "transaction successful", "refund processed".

For vague subjects (e.g. "Transaction Alert", "Notification", "Card Update"), use body_preview — amount + past-tense verb = YES.

NO: OTP / verification, statement / balance update, promo / cashback (without an actual payment), pending / scheduled / EMI reminder, login / KYC alert, marketing.

Output one object per input, same order. Copy sms_id EXACTLY.`;

// First N chars of body fed to email Pass 1 to disambiguate vague subjects.
// Most banks front-load the "Rs.X spent/debited/credited" line within the first
// 150-200 chars; longer is mostly noise.
const EMAIL_BODY_PREVIEW_CHARS = 200;

async function classifyBatch(
  messages: SMSMessage[],
  usage: ModelUsage,
): Promise<{ classifications: z.infer<typeof ClassificationsArraySchema>; model: string }> {
  // If every message in this batch carries a subject, it's an email batch
  // (Gmail Pub/Sub path) — use the email-tuned prompt + {subject, sender,
  // body_preview} input. Otherwise it's an SMS batch — keep the original SMS
  // prompt + {body, sender} input untouched. We never mix sources in the same batch today.
  const isEmailBatch =
    messages.length > 0 && messages.every((m) => m.subject && m.subject.trim());

  const systemPrompt = isEmailBatch ? EMAIL_CLASSIFY_SYSTEM_PROMPT : CLASSIFY_SYSTEM_PROMPT;

  const messagesForPrompt = isEmailBatch
    ? messages.map((m) => ({
        sms_id: m.id,
        subject: m.subject,
        sender: m.sender,
        body_preview: (m.body || "").slice(0, EMAIL_BODY_PREVIEW_CHARS),
      }))
    : messages.map((m) => ({ sms_id: m.id, body: m.body, sender: m.sender }));

  const userPrompt = `INPUT MESSAGES:\n\`\`\`json\n${JSON.stringify(messagesForPrompt)}\n\`\`\``;

  try {
    const result = await callModelWithRetry(
      PRIMARY_PROVIDER,
      CLASSIFIER_MODEL,
      systemPrompt,
      userPrompt,
      ClassificationsArraySchema,
    );
    addUsage(usage, CLASSIFIER_MODEL, result.input, result.output);
    return { classifications: result.data, model: CLASSIFIER_MODEL };
  } catch (primaryErr) {
    console.warn(
      `[ai] classifier ${CLASSIFIER_MODEL} exhausted retries (${sanitizeErrorMessage(primaryErr)}); falling back to ${FALLBACK_MODEL}`,
    );
    const result = await callModelWithRetry(
      FALLBACK_PROVIDER,
      FALLBACK_MODEL,
      systemPrompt,
      userPrompt,
      ClassificationsArraySchema,
    );
    addUsage(usage, FALLBACK_MODEL, result.input, result.output);
    return { classifications: result.data, model: FALLBACK_MODEL };
  }
}

// ── Pass 2: extract (only for messages classified as transactions) ─────────

function buildExtractBatchPrompt(categories: Category[]): string {
  const categoryList = categories.map((c) => c.slug).join(", ");
  return `Extract transaction fields from Indian banking SMS. Each input is already confirmed a transaction — don't re-classify, don't refuse.

Return null for any field not clearly stated. Don't guess or infer.

amount trap: "Available Balance" / "Avl Limit" are balance, NOT the transaction amount.

category_slug: best fit from [${categoryList}]. Use "other" only when nothing else fits.

Output one object per input, same order. Copy sms_id EXACTLY.`;
}

async function extractBatch(
  messages: SMSMessage[],
  categories: Category[],
  usage: ModelUsage,
): Promise<{ extracts: z.infer<typeof BatchExtractedArraySchema>; model: string }> {
  const systemPrompt = buildExtractBatchPrompt(categories);
  const messagesForPrompt = messages.map((m) => ({
    sms_id: m.id,
    body: m.body,
    sender: m.sender,
  }));
  const userPrompt = `INPUT MESSAGES:\n\`\`\`json\n${JSON.stringify(messagesForPrompt)}\n\`\`\``;

  try {
    const result = await callModelWithRetry(
      PRIMARY_PROVIDER,
      PRIMARY_MODEL,
      systemPrompt,
      userPrompt,
      BatchExtractedArraySchema,
    );
    addUsage(usage, PRIMARY_MODEL, result.input, result.output);
    return { extracts: result.data, model: PRIMARY_MODEL };
  } catch (primaryErr) {
    console.warn(
      `[ai] extractor ${PRIMARY_MODEL} exhausted retries (${sanitizeErrorMessage(primaryErr)}); falling back to ${FALLBACK_MODEL}`,
    );
    const result = await callModelWithRetry(
      FALLBACK_PROVIDER,
      FALLBACK_MODEL,
      systemPrompt,
      userPrompt,
      BatchExtractedArraySchema,
    );
    addUsage(usage, FALLBACK_MODEL, result.input, result.output);
    return { extracts: result.data, model: FALLBACK_MODEL };
  }
}

// ── Reclassify entry point (single SMS, called from /sync-runs/.../mark-transaction) ─────

/**
 * Extract transaction fields from a single SMS, assuming the caller has
 * already decided it IS a transaction. The prompt has no classification
 * language and explicitly permits null for any field not clearly present,
 * so the model has no incentive to hallucinate.
 */
export async function extractTransactionFields(
  message: { body: string; sender: string },
  categories: Category[]
): Promise<{ fields: ExtractedFields; model: string }> {
  const categoryList = categories.map((c) => c.slug).join(", ");

  const systemPrompt = `Extract transaction fields from a banking SMS. Already confirmed a transaction — don't re-classify, don't refuse.

Return null for any field not clearly stated. Don't guess or infer.

amount trap: "Available Balance" / "Avl Limit" are balance, NOT the transaction amount.

category_slug: best fit from [${categoryList}]. Use "other" only when nothing else fits.`;

  const userPrompt = `SMS sender: ${message.sender}
SMS body:
"""
${message.body}
"""`;

  const callOnce = async (provider: "google" | "groq", modelId: string) => {
    const result = await generateObject({
      model: getModel(provider, modelId),
      schema: ExtractedFieldsSchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0,
      maxRetries: 0,
    });
    return result.object;
  };

  try {
    const fields = await callOnce(PRIMARY_PROVIDER, PRIMARY_MODEL);
    return { fields, model: PRIMARY_MODEL };
  } catch (primaryErr) {
    console.warn(
      `[ai] extractTransactionFields primary ${PRIMARY_MODEL} failed (${sanitizeErrorMessage(primaryErr)}); falling back to ${FALLBACK_MODEL}`
    );
    try {
      const fields = await callOnce(FALLBACK_PROVIDER, FALLBACK_MODEL);
      return { fields, model: FALLBACK_MODEL };
    } catch (fallbackErr) {
      console.error("[ai] extractTransactionFields both providers failed", {
        primary: sanitizeErrorMessage(primaryErr),
        fallback: sanitizeErrorMessage(fallbackErr),
      });
      throw new Error("Failed to extract transaction fields with AI.");
    }
  }
}

// ── Ingest entry point (batched two-pass) ──────────────────────────────────

/**
 * Parse and categorize SMS messages using a two-pass flow:
 *   Pass 1: cheap classifier model decides is_transaction for ALL messages.
 *   Pass 2: extractor model runs ONLY on the survivors (often 10% of input).
 *
 * Most ingest batches are 90%+ non-transactional, so pass 2 is small or
 * skipped entirely — net token spend goes down vs. the old single-pass design.
 *
 * Public return shape is unchanged (ParsedTransaction[]) so /ingest and
 * /shortcut-ingest don't need updates. The `model` string reports the
 * extractor model (or classifier model when pass 2 was skipped).
 */
export async function parseAndCategorize(
  messages: SMSMessage[],
  categories: Category[]
): Promise<ParseAndCategorizeResult> {
  if (messages.length === 0) {
    return { parsed: [], model: PRIMARY_MODEL, usage: {} };
  }

  const usage: ModelUsage = {};

  // ── Pass 1: classify everything ──────────────────────────────────────────
  const { classifications, model: classifierModel } = await classifyBatch(messages, usage);

  // Build a sms_id → classification map keyed by Number for safety. The
  // model occasionally omits messages or duplicates ids; we tolerate both
  // (missing entries get flagged during merge below).
  const classByIds = new Map<number, z.infer<typeof ClassificationItemSchema>>();
  for (const c of classifications) classByIds.set(Number(c.sms_id), c);

  const survivors = messages.filter(
    (m) => classByIds.get(Number(m.id))?.is_transaction === true,
  );
  console.log(
    `[ai] Pass 1 done on ${classifierModel}: ${survivors.length}/${messages.length} classified as transactions`,
  );

  // ── Pass 2: extract fields, but only for survivors ───────────────────────
  const extractsById = new Map<number, z.infer<typeof BatchExtractedItemSchema>>();
  let extractorModel = classifierModel; // reported back when pass 2 is skipped
  let pass2Failed = false;

  if (survivors.length > 0) {
    try {
      const { extracts, model } = await extractBatch(survivors, categories, usage);
      extractorModel = model;
      for (const e of extracts) extractsById.set(Number(e.sms_id), e);
      console.log(
        `[ai] Pass 2 done on ${model}: ${extracts.length}/${survivors.length} extracted`,
      );
    } catch (err) {
      // Pass 2 totally failed — log and proceed. Each survivor will be marked
      // as a transaction in the merge but without fields, so the existing
      // ingest loop will skip them with "Missing amount or direction" reason.
      // User can recover via the reclassify dialog.
      pass2Failed = true;
      console.error(
        `[ai] Pass 2 (extraction) failed for entire batch of ${survivors.length}; survivors will be marked needs-review:`,
        sanitizeErrorMessage(err),
      );
    }
  }

  // ── Merge: produce one ParsedTransaction per input message ───────────────
  const parsed: ParsedTransaction[] = messages.map((m) => {
    const c = classByIds.get(Number(m.id));
    if (!c) {
      return {
        sms_id: m.id,
        is_transaction: false,
        skip_reason: "No classifier verdict for this message",
      };
    }

    if (!c.is_transaction) {
      return {
        sms_id: m.id,
        is_transaction: false,
        skip_reason: c.skip_reason || "Classified as non-transaction",
      };
    }

    // Classifier said it IS a transaction.
    const ex = extractsById.get(Number(m.id));
    if (!ex) {
      // Either pass 2 failed entirely or the extractor dropped this message.
      // Surface it as a transaction with no fields so the ingest loop's
      // "Missing amount or direction" branch flags it as skipped.
      return {
        sms_id: m.id,
        is_transaction: true,
        skip_reason: pass2Failed
          ? "Extraction failed; reclassify manually"
          : "Extractor dropped this message",
      };
    }

    return {
      sms_id: m.id,
      is_transaction: true,
      amount: ex.amount ?? undefined,
      currency: ex.currency ?? undefined,
      direction: ex.direction ?? undefined,
      merchant: ex.merchant,
      account_last4: ex.account_last4,
      bank_name: ex.bank_name,
      reference_id: ex.reference_id,
      category_slug: ex.category_slug,
    };
  });

  return { parsed, model: extractorModel, usage };
}
