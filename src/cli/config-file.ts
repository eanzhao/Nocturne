/**
 * Config-file layer for the CLI.
 *
 * Persists non-secret preferences AND (optionally) the OpenAI fallback key
 * to `~/.config/nocturne/config.json`. Env vars still win at runtime, so
 * users who prefer shell exports / 1Password wrappers / systemd drop-ins
 * don't need this file at all.
 *
 *   ~/.config/nocturne/config.json   (chmod 0600 when api_key is present)
 *   {
 *     "model": "deepseek-chat",
 *     "base_url": "https://api.openai.com/v1",
 *     "out_dir": "./out",
 *     "api_key": "sk-..."
 *   }
 *
 * Keys intentionally mirror the `NOCTURNE_OPENAI_*` env vars in snake_case
 * so a user can cp env → file or file → env without remembering a second
 * naming scheme.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const CONFIG_KEYS = [
  "model",
  "base_url",
  "out_dir",
  "api_key",
  "llm_route",
  "language",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

const ConfigFileSchema = z
  .object({
    model: z.string().min(1).optional(),
    base_url: z.string().url().optional(),
    out_dir: z.string().min(1).optional(),
    api_key: z.string().min(1).optional(),
    // `llm_route` — when set, NyxID path routes through a named proxy
    // service (`/api/v1/proxy/s/<slug>`) instead of the LLM Gateway.
    // Accepts a bare slug (`chrono-llm`) or a full path. Empty / missing =
    // use the LLM Gateway (default).
    llm_route: z.string().min(1).optional(),
    // `language` — ISO 639-1 code for the planner's output language.
    // Defaults to 'en' when unset. Today: 'en' | 'zh'.
    language: z.enum(["en", "zh"]).optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export class ConfigFileError extends Error {}

export function configFilePath(home: string = homedir()): string {
  return join(home, ".config", "nocturne", "config.json");
}

/** Read and validate the config file. Returns `{}` if the file is missing. */
export function readConfigFile(
  path: string = configFilePath(),
): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigFileError(
      `Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigFileError(
      `Schema violation in ${path}: ${result.error.issues
        .map((i) => `${i.path.join(".")} — ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/**
 * Persist a shallow merge of `updates` into the config file. Creates the
 * parent dir with mode 0700 and the file with mode 0600 (both only matter
 * when `api_key` ends up in the file, but applying them unconditionally
 * keeps the code trivially safe).
 *
 * Explicit `undefined` values in `updates` remove that key — easier than a
 * separate delete API for the CLI's `config unset` path.
 */
export function writeConfigFile(
  updates: Partial<ConfigFile>,
  path: string = configFilePath(),
): ConfigFile {
  const current = readConfigFile(path);
  const merged: ConfigFile = { ...current };
  for (const [k, v] of Object.entries(updates) as Array<
    [ConfigKey, ConfigFile[ConfigKey]]
  >) {
    if (v === undefined) {
      delete merged[k];
    } else {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Filesystems without POSIX perms (rare on dev machines) ignore chmod;
    // the data is still written, just without the 0600 guard.
  }
  return merged;
}

/**
 * One-line human summary of the config file's permission posture. Used by
 * `config list` so a user can see whether the file is readable by others.
 */
export function configFilePermSummary(
  path: string = configFilePath(),
): string | null {
  try {
    const st = statSync(path);
    const mode = st.mode & 0o777;
    return `0${mode.toString(8).padStart(3, "0")}`;
  } catch {
    return null;
  }
}
