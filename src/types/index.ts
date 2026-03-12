export interface SMSMessage {
  id: number;
  sender: string;
  body: string;
  timestamp: string | null;
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

export interface IngestResponse {
  success: boolean;
  inserted: number;
  skipped: number;
  errors: number;
  total: number;
  details?: ParsedTransactionResult[];
  run_id?: string;
}

export interface ParsedTransactionResult {
  sms_id: number;
  status: "inserted" | "skipped" | "error";
  reason?: string;
  transaction?: {
    amount: number;
    direction: "credit" | "debit";
    merchant: string | null;
    category: string | null;
  };
}
