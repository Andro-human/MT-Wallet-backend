import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesCrossChannelFingerprint,
  type CrossChannelCandidate,
} from "./deduplication.js";

function candidate(overrides: Partial<CrossChannelCandidate>): CrossChannelCandidate {
  return {
    amount: 4422.58,
    direction: "credit",
    account_last4: null,
    bank_name: null,
    transacted_at: "2026-07-24T10:29:05Z",
    source: "email",
    reference_id: null,
    merchant: "bookmyshow",
    sms_sender: "BookMyShow <tickets@bookmyshow.com>",
    ...overrides,
  } as CrossChannelCandidate;
}

test("merchant refund with no account identity on either side auto-merges (email vs SMS)", () => {
  const email = candidate({});
  const sms = candidate({
    source: "ios_shortcut",
    sms_sender: "BMSHOW-S",
    transacted_at: "2026-07-24T10:29:17Z",
  });
  assert.equal(matchesCrossChannelFingerprint(sms, email), true);
});

test("no-account merge still requires matching merchant", () => {
  const email = candidate({ merchant: "swiggy", sms_sender: "Swiggy <noreply@swiggy.in>" });
  const sms = candidate({
    source: "ios_shortcut",
    sms_sender: "BMSHOW-S",
    transacted_at: "2026-07-24T10:29:17Z",
  });
  assert.equal(matchesCrossChannelFingerprint(sms, email), false);
});

test("no-account merge does not fire when one side names a bank", () => {
  const email = candidate({});
  const sms = candidate({
    source: "ios_shortcut",
    sms_sender: "HDFCBK-S",
    bank_name: "HDFC Bank",
    transacted_at: "2026-07-24T10:29:17Z",
  });
  assert.equal(matchesCrossChannelFingerprint(sms, email), false);
});

test("same notifier never auto-merges even with identical fields", () => {
  const first = candidate({ source: "ios_shortcut", sms_sender: "BMSHOW-S" });
  const resend = candidate({
    source: "ios_shortcut",
    sms_sender: "BMSHOW-S",
    transacted_at: "2026-07-24T10:36:21Z",
  });
  assert.equal(matchesCrossChannelFingerprint(resend, first), false);
});

test("existing corroborators still work: same last4 across channels", () => {
  const email = candidate({ account_last4: "1234", merchant: null, sms_sender: "alerts@hsbc.co.in" });
  const sms = candidate({
    source: "ios_shortcut",
    sms_sender: "HSBCIN-S",
    account_last4: "1234",
    merchant: null,
    transacted_at: "2026-07-24T10:30:00Z",
  });
  assert.equal(matchesCrossChannelFingerprint(sms, email), true);
});

test("same merchant on compatible banks still merges", () => {
  const email = candidate({ bank_name: "SBI" });
  const sms = candidate({
    source: "ios_shortcut",
    sms_sender: "BMSHOW-S",
    bank_name: "SBI Card",
    transacted_at: "2026-07-24T10:30:00Z",
  });
  assert.equal(matchesCrossChannelFingerprint(sms, email), true);
});

test("outside the 30-minute window never merges", () => {
  const email = candidate({});
  const sms = candidate({
    source: "ios_shortcut",
    sms_sender: "BMSHOW-S",
    transacted_at: "2026-07-24T11:00:06Z",
  });
  assert.equal(matchesCrossChannelFingerprint(sms, email), false);
});
