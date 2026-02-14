import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  getUserByApiKey,
  getCategories,
  getCategoryIdBySlug,
  supabase,
} from "../services/supabase.js";

const router = Router();

// ─── Axio category → our slug (direct conversion, keep original categories) ──
// Only remap the few Axio names that differ from our slug format
const AXIO_CATEGORY_OVERRIDES: Record<string, string> = {
  "FOOD & DRINKS": "food", // Axio's "FOOD & DRINKS" → our existing "food" slug
};

function axioCategoryToSlug(axioCategory: string): string {
  const upper = axioCategory.trim().toUpperCase();
  // Check overrides first
  if (AXIO_CATEGORY_OVERRIDES[upper]) return AXIO_CATEGORY_OVERRIDES[upper];
  // Direct conversion: lowercase, replace spaces with hyphens
  return upper.toLowerCase().replace(/\s+/g, "-");
}

// ─── Parse Axio account string → payment_method, account_last4, bank_name ───
function parseAccount(account: string): {
  payment_method: string | null;
  account_last4: string | null;
  bank_name: string | null;
} {
  if (!account) return { payment_method: null, account_last4: null, bank_name: null };

  const acc = account.trim();

  // "CASH Spends"
  if (acc.toLowerCase().includes("cash")) {
    return { payment_method: "other", account_last4: null, bank_name: null };
  }

  // "Amazon Pay  Unknown"
  if (acc.toLowerCase().includes("amazon pay")) {
    return { payment_method: "wallet", account_last4: null, bank_name: "Amazon Pay" };
  }

  // "Simpl  Unknown"
  if (acc.toLowerCase().includes("simpl")) {
    return { payment_method: "wallet", account_last4: null, bank_name: "Simpl" };
  }

  // "HDFC credit 5487", "ICICI credit 4007", "Axis credit 7307"
  const creditMatch = acc.match(/^(\w+)\s+credit\s+(\d{4})$/i);
  if (creditMatch) {
    return {
      payment_method: "card",
      account_last4: creditMatch[2],
      bank_name: creditMatch[1] + " Bank",
    };
  }

  // "Kotak debit 8641", "PNB debit 1472"
  const debitMatch = acc.match(/^(\w+)\s+debit\s+(\d{4})$/i);
  if (debitMatch) {
    return {
      payment_method: "card",
      account_last4: debitMatch[2],
      bank_name: debitMatch[1] + " Bank",
    };
  }

  // "Kotak  3760", "PNB  1586" (UPI/bank account)
  const bankMatch = acc.match(/^(\w+)\s+(\d{4})$/);
  if (bankMatch) {
    return {
      payment_method: "upi",
      account_last4: bankMatch[2],
      bank_name: bankMatch[1] + " Bank",
    };
  }

  return { payment_method: null, account_last4: null, bank_name: null };
}

// ─── Parse amount string (handles commas, negative, etc.) ───────────────────
function parseAmount(amountStr: string): number {
  if (!amountStr) return 0;
  // Remove commas, single quotes, whitespace
  let cleaned = amountStr.replace(/[,'\s]/g, "");
  // Handle Axio's weird "'-13.0" format
  cleaned = cleaned.replace(/^'-/, "-");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.abs(num); // Always positive, direction is separate
}

// ─── Parse Axio date+time → ISO datetime ────────────────────────────────────
function parseDateTime(date: string, time: string): string {
  // date: "2025-02-02", time: "09:49 AM"
  try {
    const [timePart, ampm] = time.trim().split(" ");
    let [hours, minutes] = timePart.split(":").map(Number);

    if (ampm?.toUpperCase() === "PM" && hours !== 12) hours += 12;
    if (ampm?.toUpperCase() === "AM" && hours === 12) hours = 0;

    const h = String(hours).padStart(2, "0");
    const m = String(minutes).padStart(2, "0");

    // Return as IST (UTC+5:30)
    return `${date}T${h}:${m}:00+05:30`;
  } catch {
    return `${date}T00:00:00+05:30`;
  }
}

// ─── Axio CSV row schema ────────────────────────────────────────────────────
const AxioRowSchema = z.object({
  date: z.string(),
  time: z.string(),
  place: z.string(),
  amount: z.string(),
  direction: z.string(), // DR or CR
  account: z.string(),
  expense: z.string(), // "Yes" or "'-" or "No"
  income: z.string(), // "Yes" or "'-" or "No"
  category: z.string(),
  tags: z.string().optional(),
  note: z.string().optional(),
});

const ImportRequestSchema = z.object({
  api_key: z.string().min(1),
  rows: z.array(AxioRowSchema),
});

/**
 * POST /api/import/axio
 *
 * Import transactions from Axio CSV export
 */
router.post("/axio", async (req: Request, res: Response) => {
  const startTime = Date.now();

  const parseResult = ImportRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      success: false,
      error: "Invalid request body",
      details: parseResult.error.errors,
    });
    return;
  }

  const { rows, api_key } = parseResult.data;

  // Auth
  const user = await getUserByApiKey(api_key);
  if (!user) {
    res.status(401).json({ success: false, error: "Invalid API key" });
    return;
  }

  console.log(`[Axio Import] User ${user.id.substring(0, 8)}... - ${rows.length} rows`);

  // Get categories
  const categories = await getCategories(user.id);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const errorDetails: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    const amount = parseAmount(row.amount);
    if (amount <= 0) {
      skipped++;
      continue;
    }

    const direction = row.direction.trim().toUpperCase() === "CR" ? "credit" : "debit";
    const { payment_method, account_last4, bank_name } = parseAccount(row.account);

    // Convert Axio category to our slug (keeping original categories)
    const slug = axioCategoryToSlug(row.category);
    const categoryId = getCategoryIdBySlug(slug, categories);

    const transacted_at = parseDateTime(row.date, row.time);

    // Parse is_expense / is_income from Axio CSV fields
    // Axio uses: "Yes" = true, "No" = false, "'-" = not applicable (dash)
    const is_expense = row.expense.trim().toLowerCase() === "yes";
    const is_income = row.income.trim().toLowerCase() === "yes";

    // Build notes from Axio tags + note
    const noteParts: string[] = [];
    if (row.tags && row.tags.trim()) noteParts.push(row.tags.trim());
    if (row.note && row.note.trim()) noteParts.push(row.note.trim());
    const notes = noteParts.length > 0 ? noteParts.join(" | ") : null;

    const transactionData = {
      user_id: user.id,
      amount,
      direction,
      transacted_at,
      merchant: row.place.trim() || null,
      merchant_normalized: row.place.trim() || null,
      payment_method,
      account_last4,
      bank_name,
      reference_id: null,
      raw_sms: null,
      sms_id: null,
      sms_sender: null,
      source: "axio",
      category_id: categoryId,
      notes,
      original_amount: null,
      original_currency: null,
      is_expense,
      is_income,
    };

    const { error } = await supabase.from("transactions").insert(transactionData);

    if (error) {
      errors++;
      if (errorDetails.length < 10) {
        errorDetails.push(`Row ${i + 1}: ${error.message}`);
      }
    } else {
      inserted++;
    }
  }

  const duration = Date.now() - startTime;
  console.log(
    `[Axio Import] Completed in ${duration}ms - inserted: ${inserted}, skipped: ${skipped}, errors: ${errors}`
  );

  res.json({
    success: true,
    inserted,
    skipped,
    errors,
    total: rows.length,
    errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
  });
});

export default router;
