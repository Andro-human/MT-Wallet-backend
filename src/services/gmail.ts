import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { OAuth2Client as PubsubVerifier } from "google-auth-library";
import { env } from "../config/env.js";
import { getGmailWatchState, updateGmailWatchState } from "./supabase.js";

// Module-level caches. Both are safe to memoize for the process lifetime —
// OAuth client is bound to env credentials, label ID is stable for the mailbox.
let cachedOAuthClient: OAuth2Client | null = null;
let cachedGmailClient: gmail_v1.Gmail | null = null;
let cachedLabelId: string | null = null;
const pubsubVerifier = new PubsubVerifier();

function isGmailConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret && env.googleRedirectUri);
}

export function isGmailFullyAuthed(): boolean {
  return isGmailConfigured() && Boolean(env.googleRefreshToken);
}

/**
 * Build a fresh OAuth2 client from env credentials. The refresh-token-backed
 * runtime client is built on top of this. Not used for the consent flow
 * anymore — that's a one-time setup done from local dev when needed.
 */
function createOAuth2Client(): OAuth2Client {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new Error("Gmail integration not configured — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI");
  }
  return new google.auth.OAuth2(
    env.googleClientId,
    env.googleClientSecret,
    env.googleRedirectUri,
  );
}

/**
 * Return an authed OAuth2 client backed by the refresh token. Cached so we
 * reuse the same client (and its short-lived access token cache) across calls.
 */
function getOAuth2ClientWithRefreshToken(): OAuth2Client {
  if (cachedOAuthClient) return cachedOAuthClient;
  if (!env.googleRefreshToken) {
    throw new Error("GOOGLE_REFRESH_TOKEN not set — complete /api/auth/google first");
  }
  const client = createOAuth2Client();
  client.setCredentials({ refresh_token: env.googleRefreshToken });
  cachedOAuthClient = client;
  return client;
}

export function getGmailClient(): gmail_v1.Gmail {
  if (cachedGmailClient) return cachedGmailClient;
  cachedGmailClient = google.gmail({ version: "v1", auth: getOAuth2ClientWithRefreshToken() });
  return cachedGmailClient;
}

/**
 * Look up a Gmail label's ID by display name. Cached after first lookup.
 * Throws if the label doesn't exist — create it in Gmail's UI first.
 */
export async function getLabelIdByName(name: string): Promise<string> {
  if (cachedLabelId) return cachedLabelId;
  const gmail = getGmailClient();
  const res = await gmail.users.labels.list({ userId: "me" });
  const label = res.data.labels?.find((l) => l.name === name);
  if (!label?.id) {
    throw new Error(`Gmail label "${name}" not found. Create it in Gmail's UI first.`);
  }
  cachedLabelId = label.id;
  return label.id;
}

function base64UrlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

// Defang "preheader padding": senders (Airbnb, Mailchimp templates, etc.) pad
// the inbox snippet with sequences of invisible Unicode chars so the preview
// blurb extends further than the visible content. Left alone, this padding
// blows past our truncation window before the LLM sees the real body.
//
// First pass strips zero-width / combining marks that have no visible width.
// Second pass normalizes Unicode space-like chars (figure space, nbsp,
// ideographic space, etc.) to ASCII space so the later collapse can fold them.
function stripInvisibleAndNormalizeSpaces(text: string): string {
  // Strip zero-width / combining marks: soft hyphen, combining grapheme joiner,
  // zero-width space family (ZWSP, ZWNJ, ZWJ, LRM, RLM), word joiner, BOM.
  // Then normalize Unicode space-likes (nbsp, en/em space, figure space,
  // ideographic space, etc.) to ASCII space.
  return text
    .replace(/[\u00AD\u034F\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}

function stripHtml(html: string): string {
  return stripInvisibleAndNormalizeSpaces(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Some senders (Amazon Pay, marketing platforms) include a stub text/plain
// part like "Default email text body" with the real content only in text/html.
// We treat any text/plain shorter than this as "stub" and prefer html instead.
const MIN_PLAINTEXT_CHARS = 120;

/**
 * Walk a MIME tree, return decoded plain text. Prefers text/plain when it's
 * substantive (> MIN_PLAINTEXT_CHARS); otherwise falls back to crude HTML
 * strip on text/html. Returns "" if nothing usable found.
 */
function extractPlainTextBody(payload: gmail_v1.Schema$MessagePart | null | undefined): string {
  if (!payload) return "";

  // Collect both plain and html text from the tree, prefer whichever is more substantive.
  const plain: string[] = [];
  const html: string[] = [];

  const walk = (node: gmail_v1.Schema$MessagePart): void => {
    if (node.mimeType === "text/plain" && node.body?.data) {
      plain.push(base64UrlDecode(node.body.data));
    } else if (node.mimeType === "text/html" && node.body?.data) {
      html.push(stripHtml(base64UrlDecode(node.body.data)));
    }
    for (const child of node.parts ?? []) walk(child);
  };
  walk(payload);

  // Normalize before measuring: preheader-padding senders inflate plainText.length
  // with invisible Unicode chars, which would falsely pass the 120-char gate and
  // hide the substantive content that's only in text/html.
  const plainText = stripInvisibleAndNormalizeSpaces(plain.join("\n")).trim();
  if (plainText.length >= MIN_PLAINTEXT_CHARS) return plainText;

  const htmlText = html.join("\n").trim();
  if (htmlText) return htmlText;

  return plainText; // last resort — even a stub is better than nothing
}

/**
 * Verify a Pub/Sub push JWT against our configured audience.
 * If GCP_PUBSUB_PUSH_AUDIENCE is unset, verification is skipped (returns true)
 * with a warning — only acceptable while the subscription's OIDC auth isn't
 * yet configured. Set it as soon as you create the push subscription.
 */
export async function verifyPubSubJWT(authHeader: string | undefined): Promise<boolean> {
  if (!env.gcpPubsubPushAudience) {
    console.warn("[Gmail] GCP_PUBSUB_PUSH_AUDIENCE unset — skipping JWT verification (insecure)");
    return true;
  }
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length);
  try {
    await pubsubVerifier.verifyIdToken({ idToken: token, audience: env.gcpPubsubPushAudience });
    return true;
  } catch (err) {
    console.error("[Gmail] Pub/Sub JWT verification failed:", (err as Error).message);
    return false;
  }
}

type FetchedGmailMessage = {
  gmailMessageId: string;
  sender: string;
  subject: string;
  body: string;
  timestamp: string;
};

/**
 * Compress an email body into something an LLM can chew on cheaply.
 *  - Replaces URLs with "[link]" (bank emails are 50% tracking URLs by char count).
 *  - Collapses runs of whitespace + blank lines.
 *  - Truncates to maxChars. Bank transaction emails always front-load the
 *    amount/merchant/account info in the first few hundred chars; the rest
 *    is fraud-warning, help, footer, and disclaimer noise.
 */
const DEFAULT_AI_BODY_CHARS = 500;
export function cleanEmailBody(text: string, maxChars: number = DEFAULT_AI_BODY_CHARS): string {
  const cleaned = stripInvisibleAndNormalizeSpaces(text)
    .replace(/https?:\/\/[^\s)>]+/g, "[link]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > maxChars
    ? `${cleaned.slice(0, maxChars).trimEnd()} [truncated]`
    : cleaned;
}

/**
 * Walk Gmail history since `startHistoryId`, return all messages that
 * acquired our label in that range. Deduped by message ID. Returns [] when
 * nothing matches.
 *
 * On HTTP 404 ("historyId too old"), throws — the caller is expected to
 * reset the cursor to the current notification's historyId and lose this
 * batch (acceptable for personal-use volume; can be upgraded to a label
 * bootstrap if needed).
 */
export async function fetchNewMessagesSinceHistoryId(
  startHistoryId: string,
  labelId: string,
): Promise<FetchedGmailMessage[]> {
  const gmail = getGmailClient();
  const seen = new Set<string>();
  const messageIds: string[] = [];

  let pageToken: string | undefined = undefined;
  do {
    const params: gmail_v1.Params$Resource$Users$History$List = {
      userId: "me",
      startHistoryId,
      labelId,
      historyTypes: ["messageAdded", "labelAdded"],
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await gmail.users.history.list(params);
    for (const record of res.data.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        const id = added.message?.id;
        if (id && !seen.has(id)) { seen.add(id); messageIds.push(id); }
      }
      for (const added of record.labelsAdded ?? []) {
        const id = added.message?.id;
        if (id && !seen.has(id)) { seen.add(id); messageIds.push(id); }
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  if (messageIds.length === 0) return [];

  const out: FetchedGmailMessage[] = [];
  for (const id of messageIds) {
    const msgRes = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const msg = msgRes.data;

    // The history record can include messages whose label was later removed.
    // Re-check current label membership before processing.
    if (!msg.labelIds?.includes(labelId)) {
      console.log(`[Gmail] Skipping ${id} — label no longer present on message`);
      continue;
    }

    const headers = msg.payload?.headers ?? [];
    const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "Unknown";
    const subjectHeader = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
    const dateHeader = headers.find((h) => h.name?.toLowerCase() === "date")?.value;
    const body = extractPlainTextBody(msg.payload) || msg.snippet || "";
    const timestamp = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

    out.push({ gmailMessageId: id, sender: fromHeader, subject: subjectHeader, body, timestamp });
  }

  return out;
}

/**
 * Call gmail.users.watch and update the profile row with the new lease
 * expiration. On first run (no last_history_id stored), seed the cursor with
 * the historyId from watch's response so the next Pub/Sub notification has
 * a valid starting point. On renewals, leave the cursor alone — it must
 * advance only via processed notifications, never jump forward.
 */
export async function startOrRenewWatch(userId: string): Promise<{ historyId: string; expiresAt: Date }> {
  if (!env.gcpPubsubTopic) {
    throw new Error("GCP_PUBSUB_TOPIC not set");
  }
  const gmail = getGmailClient();
  const labelId = await getLabelIdByName(env.gmailLabelName);

  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: env.gcpPubsubTopic,
      labelIds: [labelId],
      labelFilterBehavior: "include",
    },
  });

  if (!res.data.historyId || !res.data.expiration) {
    throw new Error("gmail.users.watch() returned incomplete response");
  }

  const newHistoryId = res.data.historyId;
  const expiresAt = new Date(parseInt(res.data.expiration, 10));

  const existing = await getGmailWatchState(userId);
  if (!existing?.lastHistoryId) {
    await updateGmailWatchState(userId, {
      lastHistoryId: newHistoryId,
      watchExpiresAt: expiresAt,
    });
  } else {
    await updateGmailWatchState(userId, { watchExpiresAt: expiresAt });
  }

  return { historyId: newHistoryId, expiresAt };
}
