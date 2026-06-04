import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`FATAL: Missing required environment variable: ${name}`);
    // Log all non-npm env var names (not values) for debugging
    const envKeys = Object.keys(process.env)
      .filter(k => !k.startsWith('npm_') && !k.startsWith('_'))
      .sort()
      .join(', ');
    console.error(`   Available env var keys: ${envKeys}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

console.log("[env] Loading environment variables...");

// Validate all required env vars upfront so we fail fast with a clear message
// Google is primary; Groq is optional fallback.
const requiredVars = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
];
const missing = requiredVars.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
  const envKeys = Object.keys(process.env)
    .filter(k => !k.startsWith('npm_') && !k.startsWith('_'))
    .sort()
    .join(', ');
  console.error(`   Available env var keys: ${envKeys}`);
  process.exit(1);
}

export const env = {
  // Server
  port: parseInt(optionalEnv("PORT", "8080"), 10),
  nodeEnv: optionalEnv("NODE_ENV", "production"),
  isDev: optionalEnv("NODE_ENV", "production") === "development",

  // Supabase
  supabaseUrl: requireEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),

  // Google AI (Gemini) - primary provider
  googleApiKey: requireEnv("GOOGLE_GENERATIVE_AI_API_KEY"),

  // Groq AI - optional fallback when Gemini fails
  groqApiKey: process.env.GROQ_API_KEY,

  // Gmail Push (Pub/Sub) ingestion — all optional until the user completes
  // the OAuth flow. Without GOOGLE_REFRESH_TOKEN the Gmail pipeline stays inert.
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: optionalEnv(
    "GOOGLE_REDIRECT_URI",
    "http://localhost:3001/api/auth/google/callback",
  ),
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  gmailLabelName: optionalEnv("GMAIL_LABEL_NAME", "Inbound-Wallet"),
  gcpPubsubTopic: process.env.GCP_PUBSUB_TOPIC, // projects/<PROJECT_ID>/topics/<TOPIC>
  // Single-user mode: api_key of the user this Gmail watch is associated with.
  // We look up their profile row to read/write last_history_id and watch_expires_at.
  gmailTargetUserApiKey: process.env.GMAIL_TARGET_USER_API_KEY,
  // Optional: expected audience claim in the Pub/Sub push JWT. If unset, JWT
  // verification is skipped (insecure — set this once the push subscription
  // is configured with OIDC auth).
  gcpPubsubPushAudience: process.env.GCP_PUBSUB_PUSH_AUDIENCE,
} as const;

console.log(`[env] Loaded: PORT=${env.port}, NODE_ENV=${env.nodeEnv}`);
