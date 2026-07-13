import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  getUserByApiKey,
  getCategories,
  getSyncRunForUser,
  deleteTransactionBySmsId,
  insertTransaction,
  updateSyncRunDetail,
  addSyncRunUsage,
} from "../services/supabase.js";
import { extractTransactionFields } from "../services/ai.js";
import { nullifyStringy } from "../services/sanitize.js";

const router = Router();

// ── helpers ─────────────────────────────────────────────────────────────────

type AuthResult = {
  user?: Awaited<ReturnType<typeof getUserByApiKey>>;
  error?: string;
  status?: number;
};

async function authenticate(req: Request): Promise<AuthResult> {
  const raw = req.headers["x-api-key"];
  const apiKey = Array.isArray(raw) ? raw[0] : raw;
  if (!apiKey) return { error: "Missing x-api-key header", status: 401 };
  const user = await getUserByApiKey(apiKey);
  if (!user) return { error: "Invalid API key", status: 401 };
  return { user };
}

function parseSmsId(raw: string): number | null {
  // sms_id is a JS-number-shaped hash (sub-13 hex digits). URL param is a string.
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ── POST /api/sync-runs/:runId/messages/:smsId/mark-transaction ─────────────
//
// Two-step UX:
//   1. POST with no body  -> backend calls AI extract-only and returns
//      `{ committed: false, preview }` so the dialog can prefill.
//   2. POST with body     -> backend inserts the transaction and patches the
//      sync_run's `details[]` entry from skipped→inserted so the UI badge
//      updates. Returns `{ committed: true }`.

const ManualFieldsSchema = z.object({
  amount: z.number().positive(),
  direction: z.enum(["credit", "debit"]),
  merchant: z.string().nullable().optional(),
  account_last4: z.string().nullable().optional(),
  bank_name: z.string().nullable().optional(),
  category_slug: z.string().nullable().optional(),
  transacted_at: z.string().datetime().optional(),
  notes: z.string().nullable().optional(),
  group_id: z.string().uuid().nullable().optional(),
  is_expense: z.boolean().optional(),
  is_income: z.boolean().optional(),
});

router.post(
  "/:runId/messages/:smsId/mark-transaction",
  async (req: Request, res: Response) => {
    const auth = await authenticate(req);
    if (auth.error) {
      res.status(auth.status as number).json({ success: false, error: auth.error });
      return;
    }
    const user = auth.user!;

    const smsIdParam = String(req.params.smsId ?? "");
    const runIdParam = String(req.params.runId ?? "");
    if (!smsIdParam || !runIdParam) {
      res.status(400).json({ success: false, error: "Missing runId or smsId" });
      return;
    }
    const smsId = parseSmsId(smsIdParam);
    if (smsId === null) {
      res.status(400).json({ success: false, error: "Invalid smsId" });
      return;
    }

    const run = await getSyncRunForUser(runIdParam, user.id);
    if (!run) {
      res.status(404).json({ success: false, error: "Sync run not found" });
      return;
    }

    const sms = (run.messages ?? []).find((m) => Number(m.id) === smsId);
    if (!sms) {
      res.status(404).json({ success: false, error: "Message not found in this sync run" });
      return;
    }

    // Step 1: no body -> AI extraction preview.
    const hasBody = req.body && Object.keys(req.body).length > 0;
    if (!hasBody) {
      try {
        const categories = await getCategories(user.id);
        const { fields, model, usage } = await extractTransactionFields(
          { body: sms.body, sender: sms.sender },
          categories
        );
        addSyncRunUsage({ runId: runIdParam, userId: user.id, usage }).catch((err) =>
          console.error("[sync-runs] Failed to log reclassify usage:", err)
        );
        res.json({
          success: true,
          committed: false,
          preview: fields,
          ai_model: model,
        });
        return;
      } catch (err) {
        console.error("[sync-runs] AI extract failed:", err);
        // Don't fail hard — let the UI show an empty form.
        res.json({
          success: true,
          committed: false,
          preview: {
            amount: null,
            currency: "INR",
            direction: null,
            merchant: null,
            account_last4: null,
            bank_name: null,
            reference_id: null,
            category_slug: null,
          },
          ai_model: null,
          extract_error: "AI extraction unavailable; please fill in manually.",
        });
        return;
      }
    }

    // Step 2: body present -> validate and commit.
    const parsed = ManualFieldsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Invalid manual_fields",
        details: parsed.error.errors,
      });
      return;
    }
    const fields = parsed.data;

    // Resolve category slug -> id.
    const categories = await getCategories(user.id);
    const categoryMap = new Map(categories.map((c) => [c.slug.toLowerCase(), c.id]));
    const categoryDefMap = new Map(categories.map((c) => [c.id, c]));
    const categoryId = fields.category_slug
      ? categoryMap.get(fields.category_slug.toLowerCase()) ?? null
      : null;

    const cleanedMerchant = nullifyStringy(fields.merchant);
    const insertRes = await insertTransaction({
      user_id: user.id,
      amount: fields.amount,
      direction: fields.direction,
      transacted_at: fields.transacted_at || sms.timestamp || new Date().toISOString(),
      merchant: cleanedMerchant,
      account_last4: nullifyStringy(fields.account_last4),
      bank_name: nullifyStringy(fields.bank_name),
      reference_id: null,
      raw_sms: sms.body,
      sms_id: smsId,
      sms_sender: sms.sender,
      source: "manual",
      category_id: categoryId,
      original_amount: null,
      original_currency: null,
      is_expense: fields.is_expense ?? (fields.direction === "debit"),
      is_income: fields.is_income ?? (fields.direction === "credit"),
      needs_review: false,
      notes: fields.notes ?? null,
      group_id: fields.group_id ?? null,
    });
    if (!insertRes.success) {
      res.status(500).json({ success: false, error: insertRes.error || "Insert failed" });
      return;
    }

    // Patch sync_run.details so the badge / counts reflect the new state.
    const categorySlugForDetail =
      (categoryId ? categoryDefMap.get(categoryId)?.slug : fields.category_slug) ?? null;
    await updateSyncRunDetail({
      runId: run.id,
      userId: user.id,
      smsId,
      newDetail: {
        sms_id: smsId,
        status: "inserted",
        ai_model: "manual",
        transaction: {
          amount: fields.amount,
          direction: fields.direction,
          merchant: cleanedMerchant,
          category: categorySlugForDetail,
        },
      },
    });

    res.json({ success: true, committed: true });
  }
);

// ── POST /api/sync-runs/:runId/messages/:smsId/mark-not-transaction ─────────
router.post(
  "/:runId/messages/:smsId/mark-not-transaction",
  async (req: Request, res: Response) => {
    const auth = await authenticate(req);
    if (auth.error) {
      res.status(auth.status as number).json({ success: false, error: auth.error });
      return;
    }
    const user = auth.user!;

    const smsIdParam = String(req.params.smsId ?? "");
    const runIdParam = String(req.params.runId ?? "");
    if (!smsIdParam || !runIdParam) {
      res.status(400).json({ success: false, error: "Missing runId or smsId" });
      return;
    }
    const smsId = parseSmsId(smsIdParam);
    if (smsId === null) {
      res.status(400).json({ success: false, error: "Invalid smsId" });
      return;
    }

    const run = await getSyncRunForUser(runIdParam, user.id);
    if (!run) {
      res.status(404).json({ success: false, error: "Sync run not found" });
      return;
    }
    const exists = (run.messages ?? []).some((m) => Number(m.id) === smsId);
    if (!exists) {
      res.status(404).json({ success: false, error: "Message not found in this sync run" });
      return;
    }

    const delRes = await deleteTransactionBySmsId(user.id, smsId);
    if (!delRes.success) {
      res.status(500).json({ success: false, error: delRes.error || "Delete failed" });
      return;
    }

    await updateSyncRunDetail({
      runId: run.id,
      userId: user.id,
      smsId,
      newDetail: {
        sms_id: smsId,
        status: "skipped",
        ai_model: "manual",
        reason: "User marked as not a transaction",
      },
    });

    res.json({ success: true, committed: true });
  }
);

export default router;
