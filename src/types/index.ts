export interface SMSMessage {
  id: number;
  sender: string;
  body: string;
  timestamp: string | null;
  /**
   * Email subject (Gmail path only). When present, Pass 1 (is-transaction
   * classification) uses this instead of the body — a 5–20 token signal is
   * plenty for "did money move?" judgement, vs hundreds for a body.
   */
  subject?: string;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
}

export interface User {
  id: string;
  email?: string;
  enable_review_mode?: boolean;
}

export interface GmailWatchState {
  userId: string;
  lastHistoryId: string | null;
  watchExpiresAt: Date | null;
}

export interface UserMerchantMapping {
  id: string;
  user_id: string;
  raw_merchant: string;
  mapped_merchant: string;
  default_category_id: string | null;
  default_is_expense: boolean | null;
  default_is_income: boolean | null;
  amount_operator: '<' | '>' | '<=' | '>=' | '=' | null;
  amount_threshold: number | null;
  date_operator: '<' | '>' | '<=' | '>=' | '=' | null;
  date_threshold: number | null;
  match_type: 'exact' | 'contains';
}

export interface ParsedTransactionResult {
  sms_id: number;
  status: "inserted" | "skipped" | "error";
  ai_model?: string;
  reason?: string;
  transaction?: {
    amount: number;
    direction: "credit" | "debit";
    merchant: string | null;
    category: string | null;
  };
}
