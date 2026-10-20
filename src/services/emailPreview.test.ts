import { test } from "node:test";
import assert from "node:assert/strict";
import { emailBodyPreview } from "./emailPreview.js";

const HSBC_ALERT =
  "This e-mail has been sent by The Hongkong and Shanghai Banking Corporation Limited, India Branch, 52/60, Mahatma Gandhi Road, Fort, Mumbai - 400 001. Customer service hotline numbers . Dear Customer, We’re writing to confirm that your HSBC Credit Card xx1586 was used for a transaction of INR 127.00 at ZEPTO MARKETPLACE PRIVATE on 20/10/26. Available limit: INR 385855.00 Amount due: INR 11145.00 If you did not make this transaction, please contact us promptly.";

const BOILERPLATE = "Please do not reply to this automated message. ".repeat(15);

test("HSBC card alert keeps the verb and amount that sit behind the legal header", () => {
  const preview = emailBodyPreview(HSBC_ALERT);
  assert.match(preview, /was used for a transaction of INR 127\.00/);
});

test("short body is returned whole", () => {
  const body = "Rs.54.00 spent on your SBI Credit Card ending with 0777 at MotherDairy.";
  assert.equal(emailBodyPreview(body), body);
});

test("amount inside the head returns just the head", () => {
  const body = `₹499 debited for Netflix. ${BOILERPLATE}`;
  assert.equal(emailBodyPreview(body), body.slice(0, 300));
});

test("amount far past the head is appended with its surrounding text", () => {
  const body = `${BOILERPLATE}Your card was charged Rs. 1,513.25 at ACKO GENERAL INSURANCE today. ${BOILERPLATE}`;
  const preview = emailBodyPreview(body);
  assert.ok(preview.startsWith(body.slice(0, 300)));
  assert.match(preview, / … .*charged Rs\. 1,513\.25 at ACKO/);
  assert.ok(preview.length < 300 + 3 + 120 + 20 + 80);
});

test("amount just past the head extends the head instead of repeating text", () => {
  const body = `${"x".repeat(320)} paid INR 250 to Uber. ${BOILERPLATE}`;
  const preview = emailBodyPreview(body);
  assert.ok(!preview.includes(" … "));
  assert.match(preview, /paid INR 250 to Uber/);
});

test("words containing 'rs' are not mistaken for an amount", () => {
  const body = `Dear Customers, ${BOILERPLATE}`;
  assert.equal(emailBodyPreview(body), body.slice(0, 300));
});

test("no amount returns the head", () => {
  assert.equal(emailBodyPreview(BOILERPLATE), BOILERPLATE.slice(0, 300));
});
