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
    const result = await generateObject({
      model: google("gemini-2.5-flash"),
      schema: TransactionsArraySchema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0, // Deterministic output
    });

    return result.object;
  } catch (error) {
    console.error("AI parsing error:", error);
    throw new Error(`Failed to parse SMS with AI: ${error}`);
  }
}
