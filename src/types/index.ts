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
}

export interface IngestRequest {
  messages: SMSMessage[];
  api_key: string;
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
