/**
 * Local CLI configuration. Independent of `src/config.ts` so the strict
 * server-side schema (DATABASE_URL, NyxID URLs, ...) does not apply.
 *
 * Caller passes `process.env` (or a subset) explicitly — makes this unit
 * testable without touching real env and keeps the CLI path config-free
 * until startup.
 */
import { z } from "zod";

export class LocalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalConfigError";
  }
}

const LocalConfigSchema = z.object({
  NOCTURNE_OPENAI_API_KEY: z.string().min(1),
  NOCTURNE_OPENAI_BASE_URL: z
    .string()
    .url()
    .default("https://api.openai.com/v1"),
  NOCTURNE_OPENAI_MODEL: z.string().min(1).default("gpt-4o-mini"),
  NOCTURNE_OUT_DIR: z.string().min(1).default("./out"),
});

export interface LocalConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  outDir: string;
}

export function loadLocalConfig(
  env: Record<string, string | undefined>,
): LocalConfig {
  const parsed = LocalConfigSchema.safeParse(env);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (!first) {
      throw new LocalConfigError(
        "Invalid local config. Set NOCTURNE_OPENAI_API_KEY in your env or .env file.",
      );
    }
    const path = first.path.join(".");
    throw new LocalConfigError(
      `Invalid local config: ${path} — ${first.message}. ` +
        `Set NOCTURNE_OPENAI_API_KEY in your env or .env file.`,
    );
  }
  return {
    apiKey: parsed.data.NOCTURNE_OPENAI_API_KEY,
    baseUrl: parsed.data.NOCTURNE_OPENAI_BASE_URL,
    model: parsed.data.NOCTURNE_OPENAI_MODEL,
    outDir: parsed.data.NOCTURNE_OUT_DIR,
  };
}
