const HEAD_CHARS = 300;
const CHARS_BEFORE_AMOUNT = 120;
const CHARS_AFTER_AMOUNT = 80;

const AMOUNT_RE = /(?:\bINR|\bRs\.?|₹)\s*\d[\d,]*(?:\.\d+)?/i;

// Some banks (HSBC) open with ~250 chars of legal boilerplate, so the head alone
// can miss the amount; append the text around the first amount when it falls past it.
export function emailBodyPreview(body: string): string {
  const head = body.slice(0, HEAD_CHARS);
  const match = AMOUNT_RE.exec(body);
  if (!match) return head;

  const amountEnd = match.index + match[0].length;
  if (amountEnd <= HEAD_CHARS) return head;

  const windowStart = match.index - CHARS_BEFORE_AMOUNT;
  const windowEnd = amountEnd + CHARS_AFTER_AMOUNT;
  if (windowStart <= HEAD_CHARS) return body.slice(0, windowEnd);
  return `${head} … ${body.slice(windowStart, windowEnd)}`;
}
