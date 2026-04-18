/**
 * Config — reads every value from environment. Zero hardcoded values.
 *
 * Fails fast at startup if a required variable is missing. The server never
 * starts with partial configuration; Supabase down or NyxID down are detected
 * per-request, but a missing env var is a boot-time error.
 */

import { z } from "zod";

const ConfigSchema = z.object({
  // Server
  PORT: z.coerce.number().int().positive().default(7701),
  BASE_URL: z.string().url(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Supabase Postgres (index only)
  DATABASE_URL: z.string().min(1),

  // chrono-storage (HTML blob store)
  CHRONO_STORAGE_URL: z.string().url(),
  CHRONO_STORAGE_BUCKET: z.string().min(1).default("nocturne"),

  // NyxID (identity + LLM Gateway)
  NYXID_BASE_URL: z.string().url(),
  NYXID_JWKS_URL: z.string().url(),

  // Used for HMAC-deriving public user slugs (archive URLs)
  NYXID_SERVICE_SECRET: z.string().min(32),

  // Entropy for page_id generation (15 bytes ≈ 120 bits)
  PAGE_ID_BYTES: z.coerce.number().int().min(8).max(32).default(15),
});

export type Config = z.infer<typeof ConfigSchema>;

function load(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${missing}`);
  }
  return parsed.data;
}

export const config: Config = load();
