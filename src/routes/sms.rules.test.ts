import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRule, resolveMerchantRules, type MerchantRule } from "./sms.js";

const rule = (over: Partial<MerchantRule> = {}): MerchantRule => ({
  raw_merchant: "animesh sinha",
  mapped_merchant: "animesh sinha",
  match_type: "exact",
  default_category_id: null,
  default_is_expense: null,
  default_is_income: null,
  amount_operator: null,
  amount_threshold: null,
  date_operator: null,
  date_threshold: null,
  ...over,
});

const ctx = { amount: 20000, merchant: "animesh sinha", transactedAt: "2026-09-01T07:09:00Z" };

// The two rows a self-transfer actually had: one per toggle, saved nine seconds
// apart, each setting a different field.
const NOT_INCOME = rule({ default_is_income: false });
const NOT_EXPENSE = rule({ default_is_expense: false });

test("two rules on one merchant both apply, whichever order they arrive in", () => {
  for (const rules of [[NOT_INCOME, NOT_EXPENSE], [NOT_EXPENSE, NOT_INCOME]]) {
    const r = resolveMerchantRules(rules, ctx);
    assert.equal(r.matched, 2);
    assert.equal(r.isExpense, false, "the not-expense rule must be read");
    assert.equal(r.isIncome, false, "the not-income rule must be read");
  }
});

test("stopping at the first match is what filed a transfer as spending", () => {
  // Before the fix only one rule was consulted. With the income rule first, the
  // expense override came back null and is_expense fell through to direction.
  const r = resolveMerchantRules([NOT_INCOME], ctx);
  assert.equal(r.isIncome, false);
  assert.equal(r.isExpense, null);
});

test("a single rule resolves exactly as it did before", () => {
  const r = resolveMerchantRules([rule({ default_is_expense: true, default_category_id: "cat-1" })], ctx);
  assert.equal(r.matched, 1);
  assert.equal(r.isExpense, true);
  assert.equal(r.categoryId, "cat-1");
  assert.equal(r.merchant, "animesh sinha");
});

test("the earliest matching rule wins a field the later ones also set", () => {
  const r = resolveMerchantRules(
    [rule({ default_is_expense: false }), rule({ default_is_expense: true })],
    ctx,
  );
  assert.equal(r.isExpense, false);
});

test("rules for other merchants are not folded in", () => {
  const other = rule({ raw_merchant: "swiggy", default_is_expense: true });
  const r = resolveMerchantRules([other, NOT_EXPENSE], ctx);
  assert.equal(r.matched, 1);
  assert.equal(r.isExpense, false);
});

test("no match leaves every field null so the SMS direction decides", () => {
  const r = resolveMerchantRules([rule({ raw_merchant: "zomato" })], ctx);
  assert.deepEqual(r, {
    matched: 0,
    merchant: null,
    categoryId: null,
    isExpense: null,
    isIncome: null,
  });
});

test("a contains rule folds alongside an exact one", () => {
  const loose = rule({ raw_merchant: "animesh", match_type: "contains", default_category_id: "cat-2" });
  const r = resolveMerchantRules([loose, NOT_EXPENSE], ctx);
  assert.equal(r.matched, 2);
  assert.equal(r.categoryId, "cat-2");
  assert.equal(r.isExpense, false);
});

test("amount and date conditions still gate a rule out of the fold", () => {
  const gated = rule({ amount_operator: "<", amount_threshold: 100, default_is_expense: true });
  assert.equal(evaluateRule(gated, 20000, "animesh sinha", ctx.transactedAt), false);
  const r = resolveMerchantRules([gated, NOT_EXPENSE], ctx);
  assert.equal(r.matched, 1);
  assert.equal(r.isExpense, false);
});
