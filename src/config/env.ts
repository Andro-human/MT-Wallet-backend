import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ FATAL: Missing required environment variable: ${name}`);
    console.error(`   Available env vars: ${Object.keys(process.env).filter(k => !k.startsWith('npm_')).join(', ')}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

console.log("[env] Loading environment variables...");

export const env = {
  // Server
  port: parseInt(optionalEnv("PORT", "3001"), 10),
  nodeEnv: optionalEnv("NODE_ENV", "development"),
  isDev: optionalEnv("NODE_ENV", "development") === "development",

  // Supabase
  supabaseUrl: requireEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),

  // Google AI (Gemini)
  googleApiKey: requireEnv("GOOGLE_GENERATIVE_AI_API_KEY"),
} as const;

console.log(`[env] Loaded: PORT=${env.port}, NODE_ENV=${env.nodeEnv}`);
