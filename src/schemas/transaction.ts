import { z } from "zod";

// Schema for a single parsed transaction from LLM
export const ParsedTransactionSchema = z.object({
  sms_id: z.number(),
  is_transaction: z.boolean(),
  
  // Only present if is_transaction is true
  amount: z.number().positive().optional(),
  currency: z.string().optional(), // INR, USD, EUR, etc.
  direction: z.enum(["credit", "debit"]).optional(),
  merchant: z.string().nullable().optional(),
  payment_method: z
    .enum(["upi", "card", "neft", "imps", "netbanking", "wallet", "other"])
    .nullable()
    .optional(),
  account_last4: z.string().length(4).nullable().optional(),
  bank_name: z.string().nullable().optional(),
  reference_id: z.string().nullable().optional(),
  category_slug: z.string().nullable().optional(), // LLM picks from allowed categories
  confidence: z.enum(["high", "medium", "low"]).optional(),
  
  // Only present if is_transaction is false
  skip_reason: z.string().optional(),
});

export type ParsedTransaction = z.infer<typeof ParsedTransactionSchema>;

// Schema for the array of parsed transactions
export const ParsedTransactionsArraySchema = z.array(ParsedTransactionSchema);

// Schema for incoming SMS ingest request
export const IngestRequestSchema = z.object({
  messages: z.array(
    z.object({
      id: z.number(),
      sender: z.string(),
      body: z.string(),
      timestamp: z.string().nullable(),
    })
  ),
  api_key: z.string().min(1, "API key is required"),
});

export type IngestRequestBody = z.infer<typeof IngestRequestSchema>;

// Database transaction insert schema
export const TransactionInsertSchema = z.object({
  user_id: z.string().uuid(),
  amount: z.number().positive(),
  direction: z.enum(["credit", "debit"]),
  transacted_at: z.string().datetime(),
  merchant: z.string().nullable(),
  merchant_normalized: z.string().nullable(),
  payment_method: z.string().nullable(),
  account_last4: z.string().nullable(),
  bank_name: z.string().nullable(),
  reference_id: z.string().nullable(),
  raw_sms: z.string(),
  sms_id: z.number(),
  sms_sender: z.string(),
  source: z.literal("sms"),
  category_id: z.string().uuid().nullable(),
  original_amount: z.number().positive().nullable(),
  original_currency: z.string().nullable(),
});

export type TransactionInsert = z.infer<typeof TransactionInsertSchema>;
