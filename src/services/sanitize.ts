/**
 * Coerce stringy-nulls returned by AI extractors ("null", "NULL", "undefined",
 * "N/A", whitespace-only) into actual null. Guards against bad rows being
 * inserted — no amount of prompt tuning fully eliminates the model
 * occasionally returning the string "null" when it means JSON null.
 */
export function nullifyStringy(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return /^(null|undefined|n\/a)$/i.test(trimmed) ? null : v;
}
