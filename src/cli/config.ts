/**
 * Local CLI configuration.
 *
 * Two sources, in precedence order:
 *   1. Environment variables (`NOCTURNE_OPENAI_*`, `NOCTURNE_OUT_DIR`) —
 *      win so users with shell / systemd / 1Password-wrapper setups aren't
 *      surprised by a stale config file.
 *   2. Persisted config at `~/.config/nocturne/config.json` (managed by
 *      `nocturne-format config set/unset`).
 *   3. Defaults — applied when both above are absent.
 *
 * `NOCTURNE_OPENAI_API_KEY` is OPTIONAL at load time. The NyxID path
 * (`~/.nyxid/`) is a separate source handled by `nyxid-auth.ts`; the
 * caller checks that at least one planner source is available.
 */
import { z } from "zod";

import type { ConfigFile, ConfigKey } from "./config-file.ts";

export class LocalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalConfigError";
  }
}

/**
 * Per-key provenance so `config list` can tell the user where each
 * effective value came from. "default" means neither source set it.
 */
export type ConfigSource = "env" | "file" | "default";

export interface LocalConfig {
  /** `undefined` when the user relies on NyxID for LLM access. */
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  outDir: string;
  /**
   * Optional override for the NyxID request path. When set, the format
   * pipeline calls `{nyxid_base}/api/v1/proxy/s/<slug>` instead of the LLM
   * Gateway, so the request flows through a user-registered proxy service
   * (e.g. `chrono-llm`). `undefined` means "use the gateway" (default).
   */
  llmRoute: string | undefined;
  sources: Record<ConfigKey, ConfigSource>;
}

const DEFAULTS: Required<Omit<ConfigFile, "api_key" | "llm_route">> = {
  base_url: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  out_dir: "./out",
};

const emptyToUndef = (v: string | undefined): string | undefined =>
  v === undefined || v === "" ? undefined : v;

const EnvSchema = z.object({
  NOCTURNE_OPENAI_API_KEY: z.string().min(1).optional(),
  NOCTURNE_OPENAI_BASE_URL: z.string().url().optional(),
  NOCTURNE_OPENAI_MODEL: z.string().min(1).optional(),
  NOCTURNE_OUT_DIR: z.string().min(1).optional(),
  NOCTURNE_LLM_ROUTE: z.string().min(1).optional(),
});

/**
 * Merge env → file → defaults. Either source being invalid throws
 * `LocalConfigError`; the caller surfaces it to stderr.
 */
export function loadLocalConfig(
  env: Record<string, string | undefined>,
  file: ConfigFile = {},
): LocalConfig {
  const envNormalized = {
    NOCTURNE_OPENAI_API_KEY: emptyToUndef(env.NOCTURNE_OPENAI_API_KEY),
    NOCTURNE_OPENAI_BASE_URL: emptyToUndef(env.NOCTURNE_OPENAI_BASE_URL),
    NOCTURNE_OPENAI_MODEL: emptyToUndef(env.NOCTURNE_OPENAI_MODEL),
    NOCTURNE_OUT_DIR: emptyToUndef(env.NOCTURNE_OUT_DIR),
    NOCTURNE_LLM_ROUTE: emptyToUndef(env.NOCTURNE_LLM_ROUTE),
  };
  const parsed = EnvSchema.safeParse(envNormalized);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new LocalConfigError(
      first
        ? `Invalid env: ${first.path.join(".")} — ${first.message}`
        : "Invalid env",
    );
  }

  const pick = <K extends ConfigKey>(
    key: K,
    envVal: string | undefined,
    fileVal: string | undefined,
    fallback?: string,
  ): { value: string | undefined; source: ConfigSource } => {
    if (envVal !== undefined) return { value: envVal, source: "env" };
    if (fileVal !== undefined) return { value: fileVal, source: "file" };
    if (fallback !== undefined) return { value: fallback, source: "default" };
    return { value: undefined, source: "default" };
  };

  const model = pick(
    "model",
    parsed.data.NOCTURNE_OPENAI_MODEL,
    file.model,
    DEFAULTS.model,
  );
  const baseUrl = pick(
    "base_url",
    parsed.data.NOCTURNE_OPENAI_BASE_URL,
    file.base_url,
    DEFAULTS.base_url,
  );
  const outDir = pick(
    "out_dir",
    parsed.data.NOCTURNE_OUT_DIR,
    file.out_dir,
    DEFAULTS.out_dir,
  );
  const apiKey = pick(
    "api_key",
    parsed.data.NOCTURNE_OPENAI_API_KEY,
    file.api_key,
  );
  const llmRoute = pick(
    "llm_route",
    parsed.data.NOCTURNE_LLM_ROUTE,
    file.llm_route,
  );

  return {
    apiKey: apiKey.value,
    baseUrl: baseUrl.value!,
    model: model.value!,
    outDir: outDir.value!,
    llmRoute: llmRoute.value,
    sources: {
      model: model.source,
      base_url: baseUrl.source,
      out_dir: outDir.source,
      api_key: apiKey.source,
      llm_route: llmRoute.source,
    },
  };
}
