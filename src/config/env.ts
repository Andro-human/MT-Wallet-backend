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
const requiredVars = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
const missing = requiredVars.filter(name => !process.env[name]);
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

  // Google AI (Gemini)
  googleApiKey: requireEnv("GOOGLE_GENERATIVE_AI_API_KEY"),
} as const;

console.log(`[env] Loaded: PORT=${env.port}, NODE_ENV=${env.nodeEnv}`);
