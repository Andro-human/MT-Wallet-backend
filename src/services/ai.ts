import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { z } from "zod";
import type { SMSMessage, Category } from "../types/index.js";

// Schema for LLM output - single transaction
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
    .describe("Transaction reference or UPI ref number"),
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

// Schema for the full response array
const TransactionsArraySchema = z.array(TransactionOutputSchema);

export type ParsedTransaction = z.infer<typeof TransactionOutputSchema>;
export interface ParseAndCategorizeResult {
  parsed: ParsedTransaction[];
  model: string;
}

const PRIMARY_PROVIDER = "google";
const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_PROVIDER = "groq";
const FALLBACK_MODEL = "llama-3.3-70b-versatile";

const MAX_ATTEMPTS = 2;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

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

function tryRecoverTransactionsFromError(error: unknown): ParsedTransaction[] | null {
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
    const validated = TransactionsArraySchema.safeParse(parsedValue);
    return validated.success ? validated.data : null;
  }

  if (parsedValue && typeof parsedValue === "object") {
    const wrapped = [parsedValue];
    const validated = TransactionsArraySchema.safeParse(wrapped);
    return validated.success ? validated.data : null;
  }

  return null;
}

function assertParsedMatchesMessages(parsed: ParsedTransaction[], messages: SMSMessage[]): void {
  if (parsed.length !== messages.length) {
    throw new Error("AI output count does not match input message count.");
  }

  const expectedIds = new Set(messages.map((m) => m.id));
  const seen = new Set<number>();

  for (const row of parsed) {
    if (!expectedIds.has(row.sms_id)) {
      throw new Error("AI output contains unknown sms_id.");
    }
    if (seen.has(row.sms_id)) {
      throw new Error("AI output contains duplicate sms_id.");
    }
    seen.add(row.sms_id);
  }
}

async function callModelWithRetry(
  provider: "google" | "groq",
  modelId: string,
  systemPrompt: string,
  userPrompt: string
): Promise<ParsedTransaction[]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(
        `[ai] Calling ${modelId} attempt ${attempt}/${MAX_ATTEMPTS} (provider=${provider})`
      );

      const result = await generateObject({
        model: getModel(provider, modelId),
        schema: TransactionsArraySchema,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0,
        maxRetries: 0, // retries handled here so we control backoff + logging
      });
      if (attempt > 1) {
        console.log(`[ai] ${modelId} succeeded on attempt ${attempt}/${MAX_ATTEMPTS}`);
      }
      return result.object;
    } catch (error) {
      const recovered = tryRecoverTransactionsFromError(error);
      if (recovered) {
        console.warn(`[ai] ${modelId} recovered structured output from provider error envelope`);
        return recovered;
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

/**
 * Build the system prompt for SMS parsing
 */
function buildSystemPrompt(categories: Category[]): string {
  const categoryList = categories.map((c) => c.slug).join(", ");

  return `You are an AI parser for Indian banking SMS messages.
TASK: Extract financial transaction data.
RULES FOR PARSING:
1. Ignore OTPs, spam, and balance checks without actual money movement.
2. Amount is the TRANSACTION amount, NOT "Available Balance" or "Avl Limit". Focus on words like "debited", "spent", "credited".
3. For foreign currency (USD, EUR, etc.), set amount to the exact foreign value and currency to the code (e.g., "USD 5.90" -> 5.90, USD). Default to INR otherwise.
4. "debited" or "spent" = debit (money out). "credited" or "received" = credit (money in).
5. Extract precise merchant name, or extract UPI ID as merchant when available (e.g., "merchant@upi").
6. Extract the last 4 digits of the card or account from patterns like "Card XX1234" or "ending 1234".
7. category_slug: BEST fit from this valid list: [${categoryList}]. Use "other" if unsure.
8. If any optional field is unknown, prefer omitting it. If present, it may be null.
9. OUTPUT: Return a single JSON array only — no markdown fences, no commentary. One object per input message, same order. Every object MUST include sms_id (number, copied EXACTLY from the corresponding input message's sms_id) and is_transaction (boolean). Use direction with values "debit" or "credit" only — never use a field named "type". Use account_last4 for card/account last digits.`;
}

/**
 * Parse and categorize SMS messages using configured AI provider
 */
export async function parseAndCategorize(
  messages: SMSMessage[],
  categories: Category[]
): Promise<ParseAndCategorizeResult> {
  if (messages.length === 0) {
    return { parsed: [], model: PRIMARY_MODEL };
  }

  // Prepare messages for the prompt (only id and body needed)
  const messagesForPrompt = messages.map((m) => ({
    sms_id: m.id,
    body: m.body,
    sender: m.sender,
  }));

  const systemPrompt = buildSystemPrompt(categories);
  const userPrompt = `INPUT MESSAGES:
\`\`\`json
${JSON.stringify(messagesForPrompt)}
\`\`\`
  `;

  try {
    const parsed = await callModelWithRetry(PRIMARY_PROVIDER, PRIMARY_MODEL, systemPrompt, userPrompt);
    assertParsedMatchesMessages(parsed, messages);
    return { parsed, model: PRIMARY_MODEL };
  } catch (googleError) {
    const googleMessage = sanitizeErrorMessage(googleError);
    console.warn(
      `[ai] ${PRIMARY_MODEL} exhausted ${MAX_ATTEMPTS} attempts (${googleMessage}); falling back to ${FALLBACK_MODEL}`
    );
    try {
      const parsed = await callModelWithRetry(
        FALLBACK_PROVIDER,
        FALLBACK_MODEL,
        systemPrompt,
        userPrompt
      );
      assertParsedMatchesMessages(parsed, messages);
      return { parsed, model: FALLBACK_MODEL };
    } catch (groqError) {
      console.error("[ai] Google and Groq both failed", {
        googleError: googleMessage,
        groqError: sanitizeErrorMessage(groqError),
      });
      throw new Error(
        `Failed to parse SMS with AI after retries on ${PRIMARY_MODEL} and ${FALLBACK_MODEL}.`
      );
    }
  }
}
