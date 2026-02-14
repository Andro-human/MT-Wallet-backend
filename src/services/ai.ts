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
  payment_method: z
    .enum(["upi", "card", "neft", "imps", "netbanking", "wallet", "other"])
    .optional()
    .describe("Payment method used"),
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
  is_expense: z
    .boolean()
    .optional()
    .describe("True if this debit should count as an expense (not for self-transfers, investments, credit card payments, loan EMIs to own account)"),
  is_income: z
    .boolean()
    .optional()
    .describe("True if this credit should count as income (not for refunds, self-transfers, cashback, reversals)"),
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
  const categoryList = categories.map((c) => `- ${c.slug}: ${c.name}`).join("\n");

  return `You are a financial transaction parser for Indian banking SMS messages.

TASK: Analyze each SMS and determine if it's a financial transaction. If yes, extract all details.

RULES FOR IDENTIFYING TRANSACTIONS:
1. Must involve actual money movement (spent, received, debited, credited)
2. NOT transactions: OTPs, login alerts, balance checks, promotional offers, EMI conversions, failed/declined transactions

RULES FOR PARSING:
1. Amount is the TRANSACTION amount, NOT "Available Balance" or "Avl Limit"
2. For foreign currency transactions (USD, EUR, GBP, etc.):
   - Set "amount" to the exact foreign currency value (e.g., 5.90 for "USD 5.90")
   - Set "currency" to the currency code (e.g., "USD")
   - Example: "USD 5.90 spent" → amount: 5.90, currency: "USD"
3. For INR transactions, set currency to "INR" (or omit it)
4. "debited" or "spent" = debit (money out)
5. "credited" or "received" = credit (money in)
6. Extract UPI ID as merchant when available (e.g., "merchant@upi")
7. Extract last 4 digits from "Card XX1234" or "ending 1234"

AVAILABLE CATEGORIES (use slug):
${categoryList}

CATEGORY GUIDELINES:
- food: restaurants, food delivery (Swiggy, Zomato), cafes, fast food
- junk: junk food, fast food snacks, quick bites under ~200
- groceries: BigBasket, Blinkit, Zepto, supermarkets
- transport: Uber, Ola, Rapido, metro, parking
- fuel: petrol, diesel, IOCL, HPCL, BPCL
- shopping: Amazon, Flipkart, retail stores, online shopping
- entertainment: Netflix, Spotify, movies, games, streaming
- bills: phone recharge, electricity, rent
- subscriptions: recurring subscriptions (Netflix, Spotify, etc.)
- emi: EMI payments, loan installments
- health: pharmacy, doctor, hospital, medical
- travel: flights, hotels, IRCTC, travel booking
- trip: trip-specific expenses
- education: courses, books, school fees
- salary: salary credited
- income: other income, interest
- credit: money received from others (not salary)
- refund: refunds, cashback, reversals
- transfer: self-transfers between own accounts
- investment: mutual funds, stocks, FD, RD, SIP
- bill-payment: credit card bill payment, loan payment
- home-spend: rent, maintenance, home supplies
- gifting: gifts given
- celebration: birthday, anniversary, party expenses
- lent: money lent to someone
- charity: donations
- cat: pet expenses
- misc: miscellaneous
- other: anything that doesn't fit above
- unknown: can't determine category

IS_EXPENSE / IS_INCOME RULES (IMPORTANT):
- For DEBIT transactions, set is_expense:
  - TRUE: actual spending (food, shopping, bills, transport, etc.)
  - FALSE: self-transfers, investments, credit card bill payments, money lent, loan EMI payments to own account
- For CREDIT transactions, set is_income:
  - TRUE: salary, freelance income, interest earned, actual money received from others
  - FALSE: refunds, cashback, self-transfers, reversals, credit card rewards

OUTPUT: Return a JSON array with one object per input SMS, in the exact same order as input.`;
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
  const userPrompt = `Parse these ${messages.length} SMS messages:\n\n${JSON.stringify(messagesForPrompt, null, 2)}`;

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
