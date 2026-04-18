import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
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
    .optional()
    .describe("Merchant or sender name, or UPI ID"),
  account_last4: z
    .string()
    .optional()
    .describe("Last 4 digits of card/account number"),
  bank_name: z.string().optional().describe("Bank name"),
  reference_id: z
    .string()
    .optional()
    .describe("Transaction reference or UPI ref number"),
  category_slug: z
    .string()
    .optional()
    .describe("Category slug from the allowed list"),
  confidence: z
    .enum(["high", "medium", "low"])
    .optional()
    .describe("Confidence in the parsing accuracy"),

  // Skip reason (only when is_transaction is false)
  skip_reason: z
    .string()
    .optional()
    .describe("Why this SMS is not a transaction"),
});

// Schema for the full response array
const TransactionsArraySchema = z.array(TransactionOutputSchema);

export type ParsedTransaction = z.infer<typeof TransactionOutputSchema>;

const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.5-pro";
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callModelWithRetry(
  modelId: string,
  systemPrompt: string,
  userPrompt: string
): Promise<ParsedTransaction[]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await generateObject({
        model: google(modelId),
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
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
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
Return a JSON array exactly matching the output schema.`;
}

/**
 * Parse and categorize SMS messages using Gemini
 */
export async function parseAndCategorize(
  messages: SMSMessage[],
  categories: Category[]
): Promise<ParsedTransaction[]> {
  if (messages.length === 0) {
    return [];
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
    return await callModelWithRetry(PRIMARY_MODEL, systemPrompt, userPrompt);
  } catch (primaryError) {
    const primaryMessage =
      primaryError instanceof Error ? primaryError.message : String(primaryError);
    console.warn(
      `[ai] ${PRIMARY_MODEL} exhausted ${MAX_ATTEMPTS} attempts (${primaryMessage}); falling back to ${FALLBACK_MODEL}`
    );
    try {
      return await callModelWithRetry(FALLBACK_MODEL, systemPrompt, userPrompt);
    } catch (fallbackError) {
      console.error("[ai] Both primary and fallback models failed", {
        primaryError: primaryMessage,
        fallbackError:
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      throw new Error(
        `Failed to parse SMS with AI after retries on ${PRIMARY_MODEL} and ${FALLBACK_MODEL}: ${fallbackError}`
      );
    }
  }
}
