/**
 * Local CLI configuration. Independent of `src/config.ts` so the strict
 * server-side schema (DATABASE_URL, NyxID URLs, ...) does not apply.
 *
 * Two upstream planners the CLI can use:
 *   1. NyxID gateway (`~/.nyxid/` + `/api/v1/llm/status`) — preferred when
 *      the user has `nyxid login`'d and has ≥1 ready provider.
 *   2. Direct OpenAI-compatible API — requires `NOCTURNE_OPENAI_API_KEY`.
 *
 * `NOCTURNE_OPENAI_API_KEY` is therefore OPTIONAL at config-load time.
 * `loadLocalConfig` always succeeds if the other fields parse; the
 * caller checks that at least one planner source is available.
 *
 * Caller passes `process.env` (or a subset) explicitly — makes this unit
 * testable without touching real env.
 */
import { z } from "zod";

export class LocalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalConfigError";
  }
}

// Empty-string env values come from `export VAR=` in a shell or a parent
// process that explicitly cleared the var; we treat them as "not set" so a
// stray `NOCTURNE_OPENAI_API_KEY=` line does not trip a "too short" error.
const emptyToUndefined = (v: unknown) =>
  typeof v === "string" && v.length === 0 ? undefined : v;

const LocalConfigSchema = z.object({
  NOCTURNE_OPENAI_API_KEY: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  NOCTURNE_OPENAI_BASE_URL: z
    .string()
    .url()
    .default("https://api.openai.com/v1"),
  NOCTURNE_OPENAI_MODEL: z.string().min(1).default("gpt-4o-mini"),
  NOCTURNE_OUT_DIR: z.string().min(1).default("./out"),
});

export interface LocalConfig {
  /** `undefined` when the user relies on NyxID for LLM access. */
  apiKey: string | undefined;
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
      throw new LocalConfigError("Invalid local config.");
    }
    const path = first.path.join(".");
    throw new LocalConfigError(
      `Invalid local config: ${path} — ${first.message}`,
    );
  }
  return {
    apiKey: parsed.data.NOCTURNE_OPENAI_API_KEY,
    baseUrl: parsed.data.NOCTURNE_OPENAI_BASE_URL,
    model: parsed.data.NOCTURNE_OPENAI_MODEL,
    outDir: parsed.data.NOCTURNE_OUT_DIR,
  };
}
