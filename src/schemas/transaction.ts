import { z } from "zod";

// Database transaction insert schema
export const TransactionInsertSchema = z.object({
  user_id: z.string().uuid(),
  amount: z.number().positive(),
  direction: z.enum(["credit", "debit"]),
  transacted_at: z.string().datetime(),
  merchant: z.string().nullable(),
  account_last4: z.string().nullable(),
  bank_name: z.string().nullable(),
  reference_id: z.string().nullable(),
  raw_sms: z.string(),
  sms_id: z.number(),
  sms_sender: z.string(),
  source: z.enum(["sms", "ios_shortcut", "axio", "manual", "email"]),
  category_id: z.string().uuid().nullable(),
  original_amount: z.number().positive().nullable(),
  original_currency: z.string().nullable(),
  is_expense: z.boolean().optional(),
  is_income: z.boolean().optional(),
  needs_review: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  group_id: z.string().uuid().nullable().optional(),
});

export type TransactionInsert = z.infer<typeof TransactionInsertSchema>;
